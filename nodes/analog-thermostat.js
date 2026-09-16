const AdaptiveController = require('../lib/adaptive-controller');
const fs = require('fs');
const path = require('path');

module.exports = function(RED) {
    function AnalogThermostatNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.log('===== ANALOG THERMOSTAT VERSION 3.0.3 (AUTO MAPPING) =====');

        // ---------- Параметры ----------
        const modeMap = { 'heating': 'heat', 'cooling': 'cool', 'auto': 'heat_cool' };
        const configMode = config.mode || 'heat';
        const normalizedMode = modeMap[configMode] || configMode;

        const controllerConfig = {
            minTemp: parseFloat(config.minTemp) || 15,
            maxTemp: parseFloat(config.maxTemp) || 25,
            targetTemp: parseFloat(config.targetTemp) || 21,
            hysteresis: parseFloat(config.hysteresis) || 0.2,
            sampleInterval: (parseFloat(config.sampleInterval) || 60) * 1000,
            learningEnabled: false,
            maxOutputChange: parseFloat(config.maxOutputChange) || 0.5,
            precision: parseFloat(config.precision) || 0.5,
            mode: normalizedMode,
            operatingMode: config.operatingMode || 'manual',
            awayTemp: parseFloat(config.awayTemp) || 16
        };

        // Пользовательский маппинг (direct / inverse). Но для cool мы будем
        // автоматически использовать inverse, если пользователь не задал иное.
        const userMapping = config.outputMapping || 'direct';
        const roundToInteger = config.roundToInteger !== false;

        const controller = new AdaptiveController(controllerConfig);
        // Принудительно отключаем обучение
        controller.learningEnabled = false;
        controller.state = 'idle';
        controller.integral = 0;

        // ---------- Состояние (сохранение/восстановление) ----------
        const userDir = RED.settings.userDir || process.env.HOME || process.env.USERPROFILE;
        const storageDir = path.join(userDir, '.analog-thermostat');
        if (!fs.existsSync(storageDir)) {
            try { fs.mkdirSync(storageDir, { recursive: true }); } catch (err) {
                node.warn('Could not create storage directory: ' + err.message);
            }
        }
        function getStateFilePath(nodeId) {
            return path.join(storageDir, `state-${nodeId}.json`);
        }
        function loadStateFromFile(nodeId) {
            const filePath = getStateFilePath(nodeId);
            try {
                if (fs.existsSync(filePath)) {
                    const data = fs.readFileSync(filePath, 'utf8');
                    return JSON.parse(data);
                }
            } catch (err) {
                node.warn('Could not load state: ' + err.message);
            }
            return null;
        }
        function saveStateToFile(nodeId, state) {
            const filePath = getStateFilePath(nodeId);
            try {
                fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
            } catch (err) {
                node.warn('Could not save state: ' + err.message);
            }
        }

        let savedState = loadStateFromFile(node.id);
        if (!savedState) {
            savedState = node.context().get('controllerState');
            if (savedState) {
                saveStateToFile(node.id, savedState);
                node.context().set('controllerState', null);
                node.log('Migrated controller state from context to file');
            }
        }
        if (savedState) {
            controller.setState(savedState);
            node.log('Restored controller state');
        }

        if (config.scheduleEnabled && config.scheduleConfig && !controller.schedule) {
            const scheduleWithTimezone = { ...config.scheduleConfig, timezone: config.scheduleTimezone || 'local' };
            controller.setSchedule(scheduleWithTimezone);
            node.log('Loaded default schedule from UI config');
        }
        if (controller.schedule) {
            controller.syncSchedule();
        }

        // ---------- Вспомогательные функции ----------
        // Маппинг температуры в 0-100%. Если режим cool, автоматически инвертируем.
        function mapTemperatureToPercent(temp, minTemp, maxTemp, mode, userMapping) {
            if (maxTemp === minTemp) return 50;
            var percent = ((temp - minTemp) / (maxTemp - minTemp)) * 100;
            percent = Math.max(0, Math.min(100, percent));

            // Автоматический выбор маппинга по режиму:
            // heat -> direct, cool -> inverse
            var effectiveMapping = userMapping;
            if (mode === 'cool') {
                // Если пользователь оставил direct (по умолчанию), инвертируем
                effectiveMapping = (userMapping === 'direct') ? 'inverse' : 'direct';
            }
            // Для heat всё остаётся как задано (обычно direct)

            if (effectiveMapping === 'inverse') {
                percent = 100 - percent;
            }
            return percent;
        }

        // ---------- Обновление статуса ----------
        function updateStatus(result, percent) {
            const error = result.debug.error;
            const operatingMode = result.debug.operatingMode;
            const boostActive = result.debug.boostActive;
            const awayMode = result.debug.awayMode;
            const activeMode = result.debug.activeMode || 'heat';

            let fill = 'grey', shape = 'ring', text = '';
            if (boostActive) {
                fill = 'yellow'; shape = 'dot'; text = `BOOST ${percent}%`;
            } else if (awayMode) {
                fill = 'grey'; shape = 'ring'; text = `AWAY ${percent}%`;
            } else if (operatingMode === 'off') {
                fill = 'grey'; shape = 'ring'; text = '⏹ OFF';
            } else if (Math.abs(error) < controllerConfig.hysteresis) {
                fill = 'green'; shape = 'dot'; text = `✅ ${percent}% (${result.debug.currentTemp}°C)`;
            } else if (activeMode === 'heat') {
                fill = 'red'; shape = 'dot'; text = `🔥 ${percent}% (${result.debug.currentTemp}°C → ${result.debug.targetTemp}°C)`;
            } else if (activeMode === 'cool') {
                fill = 'blue'; shape = 'dot'; text = `❄️ ${percent}% (${result.debug.currentTemp}°C → ${result.debug.targetTemp}°C)`;
            } else {
                fill = 'grey'; shape = 'ring'; text = `${percent}% (${result.debug.currentTemp}°C)`;
            }
            node.status({ fill, shape, text });
        }

        // ---------- Обработчик входных сообщений ----------
        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            try {
                let stateChanged = false;

                if (msg.setpoint !== undefined) {
                    const temp = parseFloat(msg.setpoint);
                    if (!isNaN(temp)) {
                        controller.setSetpoint(temp);
                        node.log('Setpoint changed via msg: ' + temp);
                        stateChanged = true;
                    }
                }
                if (msg.mode !== undefined) {
                    const mode = String(msg.mode).toLowerCase();
                    const normMode = modeMap[mode] || mode;
                    if (['heat', 'cool', 'heat_cool'].includes(normMode)) {
                        controller.setMode(normMode);
                        node.log('Mode changed via msg: ' + normMode);
                        stateChanged = true;
                    }
                }
                if (msg.operatingMode !== undefined) {
                    const opMode = String(msg.operatingMode).toLowerCase();
                    if (['manual', 'schedule', 'off'].includes(opMode)) {
                        controller.setOperatingMode(opMode);
                        node.log('Operating mode changed via msg: ' + opMode);
                        stateChanged = true;
                    }
                }
                if (msg.away !== undefined) {
                    controller.setAwayMode(msg.away);
                    node.log('Away mode changed via msg');
                    stateChanged = true;
                }
                if (msg.boost !== undefined) {
                    controller.setBoost(msg.boost);
                    node.log('Boost changed via msg');
                    stateChanged = true;
                }
                if (msg.schedule !== undefined) {
                    controller.setSchedule(msg.schedule);
                    node.log('Schedule updated via msg');
                    stateChanged = true;
                }

                if (stateChanged) {
                    saveStateToFile(node.id, controller.getState());
                }

                const currentTemp = parseFloat(msg.payload);
                if (isNaN(currentTemp)) {
                    if (done) done();
                    return;
                }

                // --- Основной расчёт ---
                const result = controller.update(currentTemp);
                if (controller.hasParametersChanged()) {
                    saveStateToFile(node.id, controller.getState());
                    node.log('PID parameters updated (Kp=' + result.debug.pid.Kp +
                        ', Ki=' + result.debug.pid.Ki + ', Kd=' + result.debug.pid.Kd + ')');
                }

                // Определяем активный режим для маппинга
                const activeMode = result.debug.activeMode || result.debug.mode || 'heat';

                // Вычисляем процент с правильным маппингом
                const percent = mapTemperatureToPercent(
                    result.output,
                    controllerConfig.minTemp,
                    controllerConfig.maxTemp,
                    activeMode,
                    userMapping
                );
                const finalPercent = roundToInteger ? Math.round(percent) : percent;
                const isActive = (controller.operatingMode !== 'off') && (Math.abs(result.debug.error) > controllerConfig.hysteresis);

                // --- Дополняем debug объект ---
                const debugOut = result.debug || {};
                debugOut.analog_output = finalPercent;
                debugOut.active = isActive;
                debugOut.mode = debugOut.mode || activeMode;
                debugOut.pid = {
                    Kp: debugOut.Kp || 0,
                    Ki: debugOut.Ki || 0,
                    Kd: debugOut.Kd || 0
                };
                // Дублируем для удобства
                if (debugOut.Kp === undefined) debugOut.Kp = debugOut.pid.Kp;
                if (debugOut.Ki === undefined) debugOut.Ki = debugOut.pid.Ki;
                if (debugOut.Kd === undefined) debugOut.Kd = debugOut.pid.Kd;

                // --- Обновляем статус ---
                updateStatus(result, finalPercent);

                // --- Формируем выходные сообщения ---
                const msg1 = { payload: finalPercent, topic: msg.topic || 'thermostat/analog' };
                const msg2 = { payload: debugOut, topic: msg.topic ? msg.topic + '/debug' : 'thermostat/debug' };
                const msg3 = { payload: isActive, topic: msg.topic ? msg.topic + '/active' : 'thermostat/active' };

                send([msg1, msg2, msg3]);

                if (done) done();
            } catch (err) {
                node.error('Input error: ' + err.message);
                node.error(err.stack);
                if (done) done(err);
            }
        });

        node.on('close', function(removed, done) {
            saveStateToFile(node.id, controller.getState());
            node.log('Controller state saved (close)');
            if (done) done();
        });
    }

    RED.nodes.registerType('analog-thermostat', AnalogThermostatNode);
};
