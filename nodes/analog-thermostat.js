const AdaptiveController = require('../lib/adaptive-controller');
const fs = require('fs');
const path = require('path');

module.exports = function(RED) {
    function AnalogThermostatNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.log('===== ANALOG THERMOSTAT VERSION 2.0.1 (NODE-RED MQTT) =====');

        // Параметры (как в оригинале)
        const modeMap = { 'heating': 'heat', 'cooling': 'cool', 'auto': 'heat_cool' };
        const configMode = config.mode || 'heat';
        const normalizedMode = modeMap[configMode] || configMode;

        const controllerConfig = {
            minTemp: parseFloat(config.minTemp) || 15,
            maxTemp: parseFloat(config.maxTemp) || 25,
            targetTemp: parseFloat(config.targetTemp) || 21,
            hysteresis: parseFloat(config.hysteresis) || 0.2,
            sampleInterval: (parseFloat(config.sampleInterval) || 60) * 1000,
            learningEnabled: false,   // принудительно выключено
            maxOutputChange: parseFloat(config.maxOutputChange) || 0.5,
            precision: parseFloat(config.precision) || 0.5,
            mode: normalizedMode,
            operatingMode: config.operatingMode || 'manual',
            awayTemp: parseFloat(config.awayTemp) || 16
        };

        const analogConfig = {
            outputMapping: config.outputMapping || 'direct',
            roundToInteger: config.roundToInteger !== false
        };

        const controller = new AdaptiveController(controllerConfig);
        // Принудительно отключаем обучение
        controller.learningEnabled = false;
        controller.state = 'idle';
        controller.integral = 0;

        // Состояние (как в оригинале)
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

        // ---------- MQTT через узел Node-RED (объектный синтаксис) ----------
        let mqttClient = null;
        let mqttTopics = null;
        const uniqueId = config.mqttUniqueId || 'analog_thermostat_' + node.id;
        const baseTopic = config.mqttBaseTopic || 'homeassistant';

        if (config.mqttBroker) {
            mqttClient = RED.nodes.getNode(config.mqttBroker);
            if (mqttClient) {
                node.log('MQTT broker connected: ' + config.mqttBroker);

                // ----- Публикация Discovery (объектный синтаксис) -----
                if (config.mqttDiscovery !== false) {
                    const device = {
                        identifiers: [uniqueId],
                        name: config.mqttDeviceName || 'Analog Thermostat',
                        manufacturer: config.mqttManufacturer || 'Node-RED',
                        model: config.mqttModel || 'Analog Thermostat',
                        sw_version: '2.0.1'
                    };

                    const climateConfig = {
                        name: config.mqttDeviceName || 'Analog Thermostat',
                        unique_id: uniqueId,
                        device: device,
                        current_temperature_topic: `climate/${uniqueId}/current_temp`,
                        temperature_command_topic: `climate/${uniqueId}/set_temp`,
                        temperature_state_topic: `climate/${uniqueId}/target_temp`,
                        mode_command_topic: `climate/${uniqueId}/set_mode`,
                        mode_state_topic: `climate/${uniqueId}/mode`,
                        modes: ['heat', 'cool', 'heat_cool', 'off'],
                        min_temp: parseFloat(config.minTemp) || 15,
                        max_temp: parseFloat(config.maxTemp) || 25,
                        temp_step: parseFloat(config.precision) || 0.5,
                        retain: false
                    };
                    mqttClient.publish({ topic: `${baseTopic}/climate/${uniqueId}/config`, payload: JSON.stringify(climateConfig), retain: true });
                    node.log('MQTT Discovery climate published');

                    // Сенсор выхода
                    const sensorConfig = {
                        name: config.mqttDeviceName + ' Output',
                        unique_id: uniqueId + '_output',
                        device: device,
                        state_topic: `climate/${uniqueId}/analog_output`,
                        unit_of_measurement: '%',
                        icon: 'mdi:percent'
                    };
                    mqttClient.publish({ topic: `${baseTopic}/sensor/${uniqueId}_output/config`, payload: JSON.stringify(sensorConfig), retain: true });
                    node.log('MQTT Discovery sensor published');
                }

                // ----- Подписки на команды (объектный синтаксис) -----
                const commandTopics = [
                    `climate/${uniqueId}/set_temp`,
                    `climate/${uniqueId}/set_mode`,
                    `climate/${uniqueId}/set_operating_mode`,
                    `climate/${uniqueId}/set_away`,
                    `climate/${uniqueId}/set_boost`
                ];
                commandTopics.forEach(topic => {
                    mqttClient.subscribe({ topic: topic }, (err) => {
                        if (err) node.warn('Failed to subscribe to ' + topic);
                        else node.log('Subscribed to ' + topic);
                    });
                });

                // ----- Обработка сообщений -----
                mqttClient.on('message', (topic, payload) => {
                    try {
                        const msg = payload.toString();
                        let stateChanged = false;

                        if (topic === `climate/${uniqueId}/set_temp`) {
                            const temp = parseFloat(msg);
                            if (!isNaN(temp)) {
                                controller.setSetpoint(temp);
                                node.log('MQTT set temp: ' + temp);
                                stateChanged = true;
                            }
                        } else if (topic === `climate/${uniqueId}/set_mode`) {
                            const mode = String(msg).toLowerCase();
                            const modeMap = { 'heating': 'heat', 'cooling': 'cool', 'auto': 'heat_cool', 'off': 'off' };
                            const normalized = modeMap[mode] || mode;
                            if (['heat', 'cool', 'heat_cool', 'off'].includes(normalized)) {
                                if (normalized === 'off') {
                                    controller.setOperatingMode('off');
                                } else {
                                    controller.setMode(normalized);
                                    if (controller.operatingMode === 'off') {
                                        controller.setOperatingMode('manual');
                                    }
                                }
                                node.log('MQTT set mode: ' + normalized);
                                stateChanged = true;
                            }
                        } else if (topic === `climate/${uniqueId}/set_operating_mode`) {
                            const opMode = String(msg).toLowerCase();
                            if (['manual', 'schedule', 'off'].includes(opMode)) {
                                controller.setOperatingMode(opMode);
                                node.log('MQTT set operating mode: ' + opMode);
                                stateChanged = true;
                            }
                        } else if (topic === `climate/${uniqueId}/set_away`) {
                            const val = msg.toLowerCase();
                            if (val === 'true' || val === 'on') {
                                controller.setAwayMode(true);
                                node.log('MQTT away enabled');
                                stateChanged = true;
                            } else if (val === 'false' || val === 'off') {
                                controller.setAwayMode(false);
                                node.log('MQTT away disabled');
                                stateChanged = true;
                            } else {
                                const temp = parseFloat(val);
                                if (!isNaN(temp)) {
                                    controller.setAwayMode(temp);
                                    node.log('MQTT away set to ' + temp + '°C');
                                    stateChanged = true;
                                }
                            }
                        } else if (topic === `climate/${uniqueId}/set_boost`) {
                            if (msg === 'false' || msg === 'off') {
                                controller.setBoost(false);
                                node.log('MQTT boost disabled');
                                stateChanged = true;
                            } else {
                                try {
                                    const boost = JSON.parse(msg);
                                    if (boost.temp && boost.duration) {
                                        controller.setBoost(boost);
                                        node.log('MQTT boost: ' + boost.temp + '°C for ' + boost.duration + 'min');
                                        stateChanged = true;
                                    }
                                } catch (e) {
                                    const temp = parseFloat(msg);
                                    if (!isNaN(temp)) {
                                        controller.setBoost({ temp: temp, duration: 60 });
                                        node.log('MQTT boost: ' + temp + '°C for 60min');
                                        stateChanged = true;
                                    }
                                }
                            }
                        }

                        if (stateChanged) {
                            saveStateToFile(node.id, controller.getState());
                            publishMqttState();
                        }
                    } catch (err) {
                        node.error('MQTT message error: ' + err.message);
                    }
                });

                // ----- Публикация состояния (объектный синтаксис) -----
                function publishMqttState() {
                    if (!mqttClient) return;
                    try {
                        const state = controller.getState();
                        const result = controller.getStatus();
                        const currentTemp = state.currentTemp;
                        const targetTemp = state.targetTemp;
                        const mode = state.mode;
                        const operatingMode = state.operatingMode;

                        const percent = mapTemperatureToPercent(
                            result.output,
                            controllerConfig.minTemp,
                            controllerConfig.maxTemp,
                            analogConfig.outputMapping
                        );
                        const finalPercent = analogConfig.roundToInteger ? Math.round(percent) : percent;
                        const isActive = (operatingMode !== 'off') && (Math.abs(result.debug.error) > controllerConfig.hysteresis);

                        // Основные топики
                        if (currentTemp !== null && currentTemp !== undefined) {
                            mqttClient.publish({ topic: `climate/${uniqueId}/current_temp`, payload: String(currentTemp), retain: true });
                        }
                        if (targetTemp !== null && targetTemp !== undefined) {
                            mqttClient.publish({ topic: `climate/${uniqueId}/target_temp`, payload: String(targetTemp), retain: true });
                        }
                        mqttClient.publish({ topic: `climate/${uniqueId}/mode`, payload: (operatingMode === 'off') ? 'off' : mode, retain: true });
                        mqttClient.publish({ topic: `climate/${uniqueId}/operating_mode`, payload: operatingMode, retain: true });
                        mqttClient.publish({ topic: `climate/${uniqueId}/away`, payload: state.awayMode ? 'ON' : 'OFF', retain: true });
                        mqttClient.publish({ topic: `climate/${uniqueId}/boost`, payload: state.boostActive ? 'ON' : 'OFF', retain: true });
                        mqttClient.publish({ topic: `climate/${uniqueId}/analog_output`, payload: String(finalPercent), retain: true });
                        mqttClient.publish({ topic: `climate/${uniqueId}/active`, payload: isActive ? 'ON' : 'OFF', retain: true });

                        // Отладка
                        mqttClient.publish({ topic: `climate/${uniqueId}/error`, payload: String(result.debug.error ?? 0), retain: true });
                        mqttClient.publish({ topic: `climate/${uniqueId}/trend`, payload: result.debug.trend || 'stable', retain: true });
                        mqttClient.publish({ topic: `climate/${uniqueId}/state_info`, payload: result.debug.state || 'idle', retain: true });
                        const pid = result.debug.pid || {};
                        mqttClient.publish({ topic: `climate/${uniqueId}/pid_kp`, payload: String(pid.Kp ?? 0), retain: true });
                        mqttClient.publish({ topic: `climate/${uniqueId}/pid_ki`, payload: String(pid.Ki ?? 0), retain: true });
                        mqttClient.publish({ topic: `climate/${uniqueId}/pid_kd`, payload: String(pid.Kd ?? 0), retain: true });
                        mqttClient.publish({ topic: `climate/${uniqueId}/debug`, payload: JSON.stringify(result.debug), retain: true });

                        // Full state
                        const fullState = {
                            current_temperature: currentTemp,
                            target_temperature: targetTemp,
                            mode: (operatingMode === 'off') ? 'off' : mode,
                            operating_mode: operatingMode,
                            away: state.awayMode,
                            boost: state.boostActive,
                            pid: pid,
                            error: result.debug.error,
                            trend: result.debug.trend,
                            state: result.debug.state,
                            active_mode: result.debug.activeMode || 'idle',
                            analog_output: finalPercent
                        };
                        mqttClient.publish({ topic: `climate/${uniqueId}/state`, payload: JSON.stringify(fullState), retain: true });
                    } catch (err) {
                        node.error('publishMqttState error: ' + err.message);
                    }
                }

                node.publishMqttState = publishMqttState;

                // Закрытие
                node.on('close', function(removed, done) {
                    if (mqttClient) {
                        const topics = [
                            `climate/${uniqueId}/set_temp`,
                            `climate/${uniqueId}/set_mode`,
                            `climate/${uniqueId}/set_operating_mode`,
                            `climate/${uniqueId}/set_away`,
                            `climate/${uniqueId}/set_boost`
                        ];
                        topics.forEach(t => {
                            mqttClient.unsubscribe({ topic: t }, (err) => {});
                        });
                        if (config.mqttDiscovery !== false) {
                            mqttClient.publish({ topic: `${baseTopic}/climate/${uniqueId}/config`, payload: '', retain: true });
                            mqttClient.publish({ topic: `${baseTopic}/sensor/${uniqueId}_output/config`, payload: '', retain: true });
                        }
                    }
                    saveStateToFile(node.id, controller.getState());
                    node.log('Controller state saved');
                    if (done) done();
                });
            } else {
                node.warn('MQTT broker node not found: ' + config.mqttBroker);
            }
        }

        // ---------- Вспомогательные функции ----------
        function mapTemperatureToPercent(temp, minTemp, maxTemp, mapping) {
            if (maxTemp === minTemp) return 50;
            let percent = ((temp - minTemp) / (maxTemp - minTemp)) * 100;
            percent = Math.max(0, Math.min(100, percent));
            if (mapping === 'inverse') {
                percent = 100 - percent;
            }
            return percent;
        }

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
            if (boostActive) { fill = 'yellow'; shape = 'dot'; text = `BOOST ${percent}%`; }
            else if (awayMode) { fill = 'grey'; shape = 'ring'; text = `AWAY ${percent}%`; }
            else if (operatingMode === 'off') { fill = 'grey'; shape = 'ring'; text = '⏹ OFF'; }
            else if (Math.abs(error) < controllerConfig.hysteresis) { fill = 'green'; shape = 'dot'; text = `✅ ${percent}% (${result.debug.currentTemp}°C)`; }
            else if (activeMode === 'heat') { fill = 'red'; shape = 'dot'; text = `🔥 ${percent}% (${result.debug.currentTemp}°C → ${result.debug.targetTemp}°C)`; }
            else if (activeMode === 'cool') { fill = 'blue'; shape = 'dot'; text = `❄️ ${percent}% (${result.debug.currentTemp}°C → ${result.debug.targetTemp}°C)`; }
            else { fill = 'grey'; shape = 'ring'; text = `${percent}% (${result.debug.currentTemp}°C)`; }
            node.status({ fill, shape, text });
        }

        // ---------- Обработчик входных сообщений ----------
        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            try {
                let stateChanged = false;
                if (msg.setpoint !== undefined) {
                    const temp = parseFloat(msg.setpoint);
                    if (!isNaN(temp)) { controller.setSetpoint(temp); stateChanged = true; }
                }
                if (msg.mode !== undefined) {
                    const mode = String(msg.mode).toLowerCase();
                    const normMode = modeMap[mode] || mode;
                    if (['heat', 'cool', 'heat_cool'].includes(normMode)) {
                        controller.setMode(normMode);
                        stateChanged = true;
                    }
                }
                if (msg.operatingMode !== undefined) {
                    const opMode = String(msg.operatingMode).toLowerCase();
                    if (['manual', 'schedule', 'off'].includes(opMode)) {
                        controller.setOperatingMode(opMode);
                        stateChanged = true;
                    }
                }
                if (msg.away !== undefined) { controller.setAwayMode(msg.away); stateChanged = true; }
                if (msg.boost !== undefined) { controller.setBoost(msg.boost); stateChanged = true; }
                if (msg.schedule !== undefined) { controller.setSchedule(msg.schedule); stateChanged = true; }

                if (stateChanged) {
                    saveStateToFile(node.id, controller.getState());
                    if (node.publishMqttState) node.publishMqttState();
                }

                const currentTemp = parseFloat(msg.payload);
                if (isNaN(currentTemp)) {
                    if (done) done();
                    return;
                }

                const result = controller.update(currentTemp);
                if (controller.hasParametersChanged()) {
                    saveStateToFile(node.id, controller.getState());
                }
                if (node.publishMqttState) node.publishMqttState();
                updateStatus(result);

                const percent = mapTemperatureToPercent(
                    result.output,
                    controllerConfig.minTemp,
                    controllerConfig.maxTemp,
                    analogConfig.outputMapping
                );
                const finalPercent = analogConfig.roundToInteger ? Math.round(percent) : percent;
                const isActive = (controller.operatingMode !== 'off') && (Math.abs(result.debug.error) > controllerConfig.hysteresis);

                send([
                    { payload: finalPercent, topic: msg.topic || 'thermostat/analog' },
                    { payload: result.debug, topic: msg.topic ? msg.topic + '/debug' : 'thermostat/debug' },
                    { payload: isActive, topic: msg.topic ? msg.topic + '/active' : 'thermostat/active' }
                ]);

                if (done) done();
            } catch (err) {
                node.error('Input error: ' + err.message);
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
