const AdaptiveController = require('../lib/adaptive-controller');
const fs = require('fs');
const path = require('path');

module.exports = function (RED) {
    // Число из конфига с дефолтом, но 0 — допустимое значение
    function num(value, def) {
        const n = parseFloat(value);
        return Number.isFinite(n) ? n : def;
    }

    function toBool(v) {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v !== 0;
        const s = String(v).trim().toLowerCase();
        return ['1', 'true', 'on', 'yes'].includes(s);
    }

    function AnalogThermostatNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.log('===== ANALOG THERMOSTAT VERSION 3.0.4 (AUTO MAPPING) =====');

        // ---------- Параметры ----------
        const modeMap = { heating: 'heat', cooling: 'cool', auto: 'heat_cool' };
        const normalizeMode = (m) => modeMap[String(m || 'heat').toLowerCase()] || String(m).toLowerCase();

        let minTemp = num(config.minTemp, 15);
        let maxTemp = num(config.maxTemp, 25);
        if (minTemp >= maxTemp) {
            node.warn(`minTemp (${minTemp}) >= maxTemp (${maxTemp}); using 15..25`);
            minTemp = 15; maxTemp = 25;
        }

        const controllerConfig = {
            minTemp,
            maxTemp,
            targetTemp: num(config.targetTemp, 21),
            hysteresis: num(config.hysteresis, 0.2),
            sampleInterval: num(config.sampleInterval, 60) * 1000,
            learningEnabled: false,
            maxOutputChange: num(config.maxOutputChange, 0.5),
            precision: num(config.precision, 0.5),
            mode: normalizeMode(config.mode),
            operatingMode: config.operatingMode || 'manual',
            awayTemp: num(config.awayTemp, 16)
        };

        // 'auto' (по умолчанию): heat -> direct, cool -> inverse.
        // 'direct' / 'inverse' — жёстко, без учёта режима.
        const userMapping = config.outputMapping || 'auto';
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

        // Дебаунс записи — не дёргаем диск на каждом сообщении
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
            node.log('Restored controller state');
        }

        // Принудительно после setState — чтобы восстановленное состояние не включило обучение
        controller.learningEnabled = false;

        if (config.scheduleEnabled && config.scheduleConfig && !controller.schedule) {
            controller.setSchedule({ ...config.scheduleConfig, timezone: config.scheduleTimezone || 'local' });
            node.log('Loaded default schedule from UI config');
        }
        if (controller.schedule) controller.syncSchedule();

        // ---------- Маппинг ----------
        function mapTemperatureToPercent(temp, mode) {
            let percent = ((temp - minTemp) / (maxTemp - minTemp)) * 100;
            percent = Math.max(0, Math.min(100, percent));

            let effective = userMapping;
            if (effective === 'auto') effective = (mode === 'cool') ? 'inverse' : 'direct';

            return effective === 'inverse' ? 100 - percent : percent;
        }

        // ---------- Статус ----------
        function updateStatus(dbg, percent, isOff) {
            const error = Number(dbg.error);
            const cur = dbg.currentTemp, tgt = dbg.targetTemp;
            const activeMode = dbg.activeMode || dbg.mode || 'heat';

            let fill = 'grey', shape = 'ring', text;
            if (isOff)                          { text = '⏹ OFF'; }
            else if (dbg.boostActive)           { fill = 'yellow'; shape = 'dot'; text = `BOOST ${percent}%`; }
            else if (dbg.awayMode)              { text = `AWAY ${percent}%`; }
            else if (!Number.isFinite(error))   { text = `${percent}% (error: n/a)`; }
            else if (Math.abs(error) <= controllerConfig.hysteresis) {
                fill = 'green'; shape = 'dot'; text = `✅ ${percent}% (${cur}°C)`;
            } else if (activeMode === 'heat') {
                fill = 'red'; shape = 'dot'; text = `🔥 ${percent}% (${cur}°C → ${tgt}°C)`;
            } else if (activeMode === 'cool') {
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
                if (msg.away !== undefined)     { controller.setAwayMode(toBool(msg.away)); stateChanged = true; }
                if (msg.boost !== undefined)    { controller.setBoost(toBool(msg.boost));   stateChanged = true; }
                if (msg.schedule !== undefined) { controller.setSchedule(msg.schedule);     stateChanged = true; }

                if (stateChanged) saveState();

                const currentTemp = parseFloat(msg.payload);
                if (!Number.isFinite(currentTemp)) {
                    // Команда без температуры — просто применили настройки
                    return done();
                }

                // --- Расчёт ---
                const result = controller.update(currentTemp);
                const dbg = (result && result.debug) ? result.debug : {};

                // Коэффициенты: берём из dbg.pid, иначе из плоских полей
                const pid = dbg.pid || { Kp: dbg.Kp ?? 0, Ki: dbg.Ki ?? 0, Kd: dbg.Kd ?? 0 };
                dbg.pid = pid;
                if (dbg.Kp === undefined) dbg.Kp = pid.Kp;
                if (dbg.Ki === undefined) dbg.Ki = pid.Ki;
                if (dbg.Kd === undefined) dbg.Kd = pid.Kd;

                if (controller.hasParametersChanged()) {
                    saveState();
                    node.log(`PID parameters updated (Kp=${pid.Kp}, Ki=${pid.Ki}, Kd=${pid.Kd})`);
                }

                const activeMode = dbg.activeMode || dbg.mode || controllerConfig.mode;
                const isOff = controller.operatingMode === 'off';
                const error = Number(dbg.error);

                let percent = isOff ? 0 : mapTemperatureToPercent(result.output, activeMode);
                if (roundToInteger) percent = Math.round(percent);

                const isActive = !isOff && Number.isFinite(error) &&
                                 Math.abs(error) > controllerConfig.hysteresis;

                dbg.analog_output = percent;
                dbg.active = isActive;
                dbg.mode = dbg.mode || activeMode;
                dbg.activeMode = activeMode;
                dbg.off = isOff;

                updateStatus(dbg, percent, isOff);

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
            if (removed) {
                try { fs.unlinkSync(stateFile); } catch (_) { /* файла может не быть */ }
            }
            node.log('Controller state saved (close)');
            done();
        });
    }

    RED.nodes.registerType('analog-thermostat', AnalogThermostatNode);
};
