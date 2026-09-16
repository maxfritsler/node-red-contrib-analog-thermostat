const AdaptiveController = require('../lib/adaptive-controller');
const fs = require('fs');
const path = require('path');

module.exports = function (RED) {
    // Число с дефолтом; 0 — допустимое значение
    function num(value, def) {
        const n = typeof value === 'string' ? parseFloat(value) : value;
        return Number.isFinite(n) ? n : def;
    }

    function toBool(v) {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v !== 0;
        return ['1', 'true', 'on', 'yes'].includes(String(v).trim().toLowerCase());
    }

    function AnalogThermostatNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.log('===== ANALOG THERMOSTAT VERSION 4.0.0 (PID 0-100%) =====');

        // ---------- Параметры ----------
        const modeMap = { heating: 'heat', cooling: 'cool', auto: 'heat_cool' };
        const normalizeMode = (m) => {
            const s = String(m || 'heat').toLowerCase();
            return modeMap[s] || s;
        };

        let minTemp = num(config.minTemp, 15);
        let maxTemp = num(config.maxTemp, 30);
        if (minTemp >= maxTemp) {
            node.warn(`minTemp (${minTemp}) >= maxTemp (${maxTemp}); using 15..30`);
            minTemp = 15; maxTemp = 30;
        }

        const controllerConfig = {
            minTemp,
            maxTemp,
            targetTemp: num(config.targetTemp, 21),
            hysteresis: num(config.hysteresis, 0.2),
            sampleInterval: num(config.sampleInterval, 60) * 1000,
            learningEnabled: config.learningEnabled === true,
            maxOutputChange: num(config.maxOutputChange, 10),   // %/цикл
            precision: num(config.precision, 0.5),
            mode: normalizeMode(config.mode),
            operatingMode: config.operatingMode || 'manual',
            awayTemp: num(config.awayTemp, 16),
            Kp: num(config.Kp, 20),    // %/°C
            Ki: num(config.Ki, 0.5),   // %/(°C·мин)
            Kd: num(config.Kd, 0)      // %·мин/°C
        };

        // 'direct' — 0 % = нет воздействия. 'inverse' — только для привода с обратной логикой.
        const inverse = config.outputMapping === 'inverse';
        const roundToInteger = config.roundToInteger !== false;

        const controller = new AdaptiveController(controllerConfig);

        // ---------- Хранилище состояния ----------
        const userDir = RED.settings.userDir || process.env.HOME || process.env.USERPROFILE || '.';
        const storageDir = path.join(userDir, '.analog-thermostat');
        try { fs.mkdirSync(storageDir, { recursive: true }); }
        catch (err) { node.warn('Could not create storage directory: ' + err.message); }

        const stateFile = path.join(storageDir, `state-${node.id}.json`);

        function loadState() {
            try {
                if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            } catch (err) { node.warn('Could not load state: ' + err.message); }
            return null;
        }

        let saveTimer = null;
        function saveState(immediate = false) {
            const write = () => {
                saveTimer = null;
                try { fs.writeFileSync(stateFile, JSON.stringify(controller.getState(), null, 2), 'utf8'); }
                catch (err) { node.warn('Could not save state: ' + err.message); }
            };
            if (immediate) { if (saveTimer) clearTimeout(saveTimer); write(); return; }
            if (!saveTimer) saveTimer = setTimeout(write, 2000);
        }

        let savedState = loadState();
        if (!savedState) {
            savedState = node.context().get('controllerState');
            if (savedState) {
                node.context().set('controllerState', undefined);
                node.log('Migrated controller state from context to file');
            }
        }
        if (savedState) {
            controller.setState(savedState);
            node.log('Restored controller state' + (savedState.version === 2 ? '' : ' (legacy format: PID state discarded)'));
        }
        controller.learningEnabled = controllerConfig.learningEnabled;

        if (config.scheduleEnabled && config.scheduleConfig && !controller.schedule) {
            controller.setSchedule({ ...config.scheduleConfig, timezone: config.scheduleTimezone || 'local' });
            node.log('Loaded default schedule from UI config');
        }
        if (controller.schedule) controller.syncSchedule();

        // ---------- Статус ----------
        function updateStatus(dbg, percent, isOff, rawOutput) {
            const cur = dbg.currentTemp, tgt = dbg.targetTemp;
            const dir = dbg.activeMode || 'idle';
            let fill = 'grey', shape = 'ring', text;

            if (isOff)                    { text = '⏹ OFF'; }
            else if (dbg.boostActive)     { fill = 'yellow'; shape = 'dot'; text = `BOOST ${percent}% (${cur}°C → ${tgt}°C)`; }
            else if (dbg.awayMode)        { text = `AWAY ${percent}% (${cur}°C → ${tgt}°C)`; }
            else if (dir === 'idle' || rawOutput === 0) {
                fill = 'green'; shape = 'dot'; text = `✅ ${percent}% (${cur}°C / ${tgt}°C)`;
            } else if (dir === 'heat') {
                fill = 'red'; shape = 'dot'; text = `🔥 ${percent}% (${cur}°C → ${tgt}°C)`;
            } else if (dir === 'cool') {
                fill = 'blue'; shape = 'dot'; text = `❄️ ${percent}% (${cur}°C → ${tgt}°C)`;
            } else {
                text = `${percent}% (${cur}°C)`;
            }
            node.status({ fill, shape, text });
        }

        // ---------- Вход ----------
        node.on('input', function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) node.error(err, msg); };

            try {
                let stateChanged = false;

                if (msg.setpoint !== undefined) {
                    const t = parseFloat(msg.setpoint);
                    if (Number.isFinite(t)) { controller.setSetpoint(t); stateChanged = true; }
                    else node.warn('Ignored invalid setpoint: ' + msg.setpoint);
                }
                if (msg.mode !== undefined) {
                    const m = normalizeMode(msg.mode);
                    if (['heat', 'cool', 'heat_cool'].includes(m)) { controller.setMode(m); stateChanged = true; }
                    else node.warn('Ignored invalid mode: ' + msg.mode);
                }
                if (msg.operatingMode !== undefined) {
                    const op = String(msg.operatingMode).toLowerCase();
                    if (['manual', 'schedule', 'off'].includes(op)) { controller.setOperatingMode(op); stateChanged = true; }
                    else node.warn('Ignored invalid operatingMode: ' + msg.operatingMode);
                }
                if (msg.away !== undefined) {
                    const a = typeof msg.away === 'number' ? msg.away : toBool(msg.away);
                    controller.setAwayMode(a); stateChanged = true;
                }
                if (msg.boost !== undefined) {
                    const b = (msg.boost && typeof msg.boost === 'object') ? msg.boost : (toBool(msg.boost) ? { temp: controller.targetTemp + 2, duration: 60 } : false);
                    controller.setBoost(b); stateChanged = true;
                }
                if (msg.schedule !== undefined) { controller.setSchedule(msg.schedule); stateChanged = true; }
                if (msg.reset !== undefined && toBool(msg.reset)) {
                    controller.integral = 0; controller.lastOutput = 0; controller.direction = 'idle';
                    node.log('PID state reset'); stateChanged = true;
                }

                if (stateChanged) saveState();

                const currentTemp = parseFloat(msg.payload);
                if (!Number.isFinite(currentTemp)) return done();   // только команда

                // --- Расчёт ---
                const result = controller.update(currentTemp);
                const dbg = result.debug || {};
                const isOff = controller.operatingMode === 'off';
                const rawOutput = isOff ? 0 : result.output;   // 0..100 % усилия

                let percent = inverse ? 100 - rawOutput : rawOutput;
                if (roundToInteger) percent = Math.round(percent);
                else percent = Math.round(percent * 10) / 10;

                const isActive = !isOff && rawOutput > 0;

                if (controller.hasParametersChanged()) {
                    saveState();
                    node.log(`PID updated (Kp=${dbg.pid.Kp}, Ki=${dbg.pid.Ki}, Kd=${dbg.pid.Kd})`);
                }

                dbg.analog_output = percent;
                dbg.effort = rawOutput;
                dbg.active = isActive;
                dbg.off = isOff;

                updateStatus(dbg, percent, isOff, rawOutput);

                const base = msg.topic || 'thermostat';
                send([
                    { payload: percent,  topic: msg.topic || 'thermostat/analog' },
                    { payload: dbg,      topic: base + '/debug' },
                    { payload: isActive, topic: base + '/active' }
                ]);
                done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error: ' + err.message });
                done(err);
            }
        });

        node.on('close', function (removed, done) {
            saveState(true);
            if (removed) { try { fs.unlinkSync(stateFile); } catch (_) { /* нет файла */ } }
            done();
        });
    }

    RED.nodes.registerType('analog-thermostat', AnalogThermostatNode);
};
