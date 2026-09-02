// ========================================================================
// Аналоговый термостат (0-100%) без встроенного MQTT
// Вход: msg.payload = текущая температура
// Выход 1: 0-100% (число)
// Выход 2: объект состояния (debug)
// Выход 3: активность (true/false)
// Команды через msg:
//   msg.setpoint (number) – уставка
//   msg.mode (string) – heat, cool, heat_cool
//   msg.operatingMode (string) – manual, schedule, off
//   msg.away (boolean или number) – включить/выключить Away или температура
//   msg.boost (object или boolean) – {temp, duration} или false
//   msg.schedule (object) – расписание
// ========================================================================

const AdaptiveController = require('../lib/adaptive-controller');
const fs = require('fs');
const path = require('path');

module.exports = function(RED) {
    function AnalogThermostatNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.log('===== ANALOG THERMOSTAT VERSION 3.0.0 (NO MQTT) =====');

        // --- Параметры ---
        const modeMap = { 'heating': 'heat', 'cooling': 'cool', 'auto': 'heat_cool' };
        const configMode = config.mode || 'heat';
        const normalizedMode = modeMap[configMode] || configMode;

        const controllerConfig = {
            minTemp: parseFloat(config.minTemp) || 15,
            maxTemp: parseFloat(config.maxTemp) || 25,
            targetTemp: parseFloat(config.targetTemp) || 21,
            hysteresis: parseFloat(config.hysteresis) || 0.2,
            sampleInterval: (parseFloat(config.sampleInterval) || 60) * 1000,
            learningEnabled: false,          // обучение отключено
            maxOutputChange: parseFloat(config.maxOutputChange) || 0.5,
            precision: parseFloat(config.precision) || 0.5,
            mode: normalizedMode,
            operatingMode: config.operatingMode || 'manual',
            awayTemp: parseFloat(config.awayTemp) || 16
        };

        // Настройки аналогового выхода
        const analogConfig = {
            outputMapping: config.outputMapping || 'direct',
            roundToInteger: config.roundToInteger !== false
        };

        const controller = new AdaptiveController(controllerConfig);
        // Принудительно выключаем обучение и сбрасываем интеграл
        controller.learningEnabled = false;
        controller.state = 'idle';
        controller.integral = 0;

        // --- Состояние (сохранение/восстановление) ---
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
            node.log('Restored controller state (Kp=' + savedState.Kp + ', Ki=' + savedState.Ki + ', Kd=' + savedState.Kd + ')');
        }

        if (config.scheduleEnabled && config.scheduleConfig && !controller.schedule) {
            const scheduleWithTimezone = { ...config.scheduleConfig, timezone: config.scheduleTimezone || 'local' };
            controller.setSchedule(scheduleWithTimezone);
            node.log('Loaded default schedule from UI config');
        }
        if (controller.schedule) {
            controller.syncSchedule();
        }

        // --- Вспомогательная функция маппинга ---
        function mapTemperatureToPercent(temp, minTemp, maxTemp, mapping) {
            if (maxTemp === minTemp) return 50;
            let percent = ((temp - minTemp) / (maxTemp - minTemp)) * 100;
            percent = Math.max(0, Math.min(100, percent));
            if (mapping === 'inverse') {
                percent = 100 - percent;
            }
            return percent;
        }

        // --- Обновление статуса узла ---
        function updateStatus(result) {
            const error = result.debug.error;
            const operatingMode = result.debug.operatingMode;
            const boostActive = result.debug.boostActive;
            const awayMode = result.debug.awayMode;
            const activeMode = result.debug.activeMode || 'heat';
            const percent = Math.round(mapTemperatureToPercent(
                result.output,
                controllerConfig.minTemp,
                controllerConfig.maxTemp,
                analogConfig.outputMapping
            ));

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

        // --- Обработчик входных сообщений ---
        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            try {
                let stateChanged = false;

                // ========== ОБРАБОТКА КОМАНД ИЗ msg ==========
                // 1. Уставка
                if (msg.setpoint !== undefined) {
                    const temp = parseFloat(msg.setpoint);
                    if (!isNaN(temp)) {
                        controller.setSetpoint(temp);
                        node.log('Setpoint changed via msg: ' + temp);
                        stateChanged = true;
                    } else {
                        node.warn('Invalid setpoint value: ' + msg.setpoint);
                    }
                }
                // 2. Режим (heat/cool/heat_cool)
                if (msg.mode !== undefined) {
                    const mode = String(msg.mode).toLowerCase();
                    const normMode = modeMap[mode] || mode;
                    if (['heat', 'cool', 'heat_cool'].includes(normMode)) {
                        controller.setMode(normMode);
                        node.log('Mode changed via msg: ' + normMode);
                        stateChanged = true;
                    } else {
                        node.warn('Invalid mode: ' + msg.mode);
                    }
                }
                // 3. Режим работы (manual/schedule/off)
                if (msg.operatingMode !== undefined) {
                    const opMode = String(msg.operatingMode).toLowerCase();
                    if (['manual', 'schedule', 'off'].includes(opMode)) {
                        controller.setOperatingMode(opMode);
                        node.log('Operating mode changed via msg: ' + opMode);
                        stateChanged = true;
                    } else {
                        node.warn('Invalid operatingMode: ' + msg.operatingMode);
                    }
                }
                // 4. Away
                if (msg.away !== undefined) {
                    controller.setAwayMode(msg.away);
                    node.log('Away mode changed via msg');
                    stateChanged = true;
                }
                // 5. Boost
                if (msg.boost !== undefined) {
                    controller.setBoost(msg.boost);
                    node.log('Boost changed via msg');
                    stateChanged = true;
                }
                // 6. Расписание
                if (msg.schedule !== undefined) {
                    controller.setSchedule(msg.schedule);
                    node.log('Schedule updated via msg');
                    stateChanged = true;
                }

                // Если изменилось состояние, сохраняем
                if (stateChanged) {
                    saveStateToFile(node.id, controller.getState());
                }

                // ---- Получение текущей температуры ----
                const currentTemp = parseFloat(msg.payload);
                if (isNaN(currentTemp)) {
                    // Если нет температуры, но была команда – просто выходим
                    if (done) done();
                    return;
                }

                // ---- Основной расчёт ----
                const result = controller.update(currentTemp);
                if (controller.hasParametersChanged()) {
                    saveStateToFile(node.id, controller.getState());
                    node.log('PID parameters updated (Kp=' + result.debug.pid.Kp +
                        ', Ki=' + result.debug.pid.Ki + ', Kd=' + result.debug.pid.Kd + ')');
                }

                // Обновляем статус
                updateStatus(result);

                // ---- Формируем выходы ----
                const percent = mapTemperatureToPercent(
                    result.output,
                    controllerConfig.minTemp,
                    controllerConfig.maxTemp,
                    analogConfig.outputMapping
                );
                const finalPercent = analogConfig.roundToInteger ? Math.round(percent) : percent;
                const isActive = (controller.operatingMode !== 'off') && (Math.abs(result.debug.error) > controllerConfig.hysteresis);

                // Выход 1: 0-100%
                const msg1 = { payload: finalPercent, topic: msg.topic || 'thermostat/analog' };

                // Выход 2: объект состояния (debug)
                const msg2 = { payload: result.debug, topic: msg.topic ? msg.topic + '/debug' : 'thermostat/debug' };

                // Выход 3: активность
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
