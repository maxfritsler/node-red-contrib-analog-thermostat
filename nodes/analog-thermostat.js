const AdaptiveController = require('../lib/adaptive-controller');
const fs = require('fs');
const path = require('path');

module.exports = function(RED) {
    // Директория для хранения состояния
    const userDir = RED.settings.userDir || process.env.HOME || process.env.USERPROFILE;
    const storageDir = path.join(userDir, '.analog-thermostat');
    if (!fs.existsSync(storageDir)) {
        try { fs.mkdirSync(storageDir, { recursive: true }); } catch (err) {
            RED.log.warn('analog-thermostat: Could not create storage directory: ' + err.message);
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
            RED.log.warn('analog-thermostat: Could not load state: ' + err.message);
        }
        return null;
    }

    function saveStateToFile(nodeId, state) {
        const filePath = getStateFilePath(nodeId);
        try {
            fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
        } catch (err) {
            RED.log.warn('analog-thermostat: Could not save state: ' + err.message);
        }
    }

    function buildDiscoveryConfig(node, uniqueId) {
        const baseTopic = node.mqttBaseTopic || 'homeassistant';
        const deviceName = node.mqttDeviceName || 'Analog Thermostat';
        const manufacturer = node.mqttManufacturer || 'Node-RED';
        const model = node.mqttModel || 'Analog Thermostat';

        const stateTopic = `climate/${uniqueId}/state`;
        const tempCommandTopic = `climate/${uniqueId}/set_temp`;
        const modeCommandTopic = `climate/${uniqueId}/set_mode`;
        const currentTempTopic = `climate/${uniqueId}/current_temp`;
        const targetTempTopic = `climate/${uniqueId}/target_temp`;
        const modeStateTopic = `climate/${uniqueId}/mode`;
        const analogOutputTopic = `climate/${uniqueId}/analog_output`;
        const activeTopic = `climate/${uniqueId}/active`;

        const config = {
            name: deviceName,
            unique_id: uniqueId,
            device: {
                identifiers: [uniqueId],
                name: deviceName,
                manufacturer: manufacturer,
                model: model,
                sw_version: '1.0.0'
            },
            current_temperature_topic: currentTempTopic,
            temperature_command_topic: tempCommandTopic,
            temperature_state_topic: targetTempTopic,
            mode_command_topic: modeCommandTopic,
            mode_state_topic: modeStateTopic,
            modes: ['heat', 'cool', 'heat_cool', 'off'],
            min_temp: parseFloat(node.minTemp) || 15,
            max_temp: parseFloat(node.maxTemp) || 25,
            temp_step: parseFloat(node.precision) || 0.5,
            retain: false,
        };
        return {
            config: config,
            discoveryTopic: `${baseTopic}/climate/${uniqueId}/config`,
            stateTopic: stateTopic,
            tempCommandTopic: tempCommandTopic,
            modeCommandTopic: modeCommandTopic,
            currentTempTopic: currentTempTopic,
            targetTempTopic: targetTempTopic,
            modeStateTopic: modeStateTopic,
            analogOutputTopic: analogOutputTopic,
            activeTopic: activeTopic
        };
    }

    function AnalogThermostatNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Нормализация режима
        const modeMap = { 'heating': 'heat', 'cooling': 'cool', 'auto': 'heat_cool' };
        const configMode = config.mode || 'heat';
        const normalizedMode = modeMap[configMode] || configMode;

        const controllerConfig = {
            minTemp: parseFloat(config.minTemp) || 15,
            maxTemp: parseFloat(config.maxTemp) || 25,
            targetTemp: parseFloat(config.targetTemp) || 21,
            hysteresis: parseFloat(config.hysteresis) || 0.2,
            sampleInterval: (parseFloat(config.sampleInterval) || 60) * 1000,
            learningEnabled: config.learningEnabled !== false,
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

        let wasHeatingActive = false;
        let wasCoolingActive = false;

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

        // ========== MQTT настройки ==========
        let mqttClient = null;
        let mqttTopics = null;
        let uniqueId = config.mqttUniqueId || 'analog_thermostat_' + node.id;

        if (config.mqttBroker) {
            mqttClient = RED.nodes.getNode(config.mqttBroker);
            if (mqttClient) {
                node.log('MQTT broker connected: ' + config.mqttBroker);
                mqttTopics = buildDiscoveryConfig(node, uniqueId);

                // Подписка на команды (объектный синтаксис)
                const subscribeTopics = [
                    mqttTopics.tempCommandTopic,
                    mqttTopics.modeCommandTopic,
                    `climate/${uniqueId}/set_operating_mode`,
                    `climate/${uniqueId}/set_away`,
                    `climate/${uniqueId}/set_boost`
                ];
                subscribeTopics.forEach(topic => {
                    mqttClient.subscribe({ topic: topic }, (err) => {
                        if (!err) node.log('Subscribed to MQTT topic: ' + topic);
                        else node.warn('Failed to subscribe to ' + topic + ': ' + err);
                    });
                });

                // Обработчик входящих MQTT сообщений
                mqttClient.on('message', (topic, payload) => {
                    try {
                        const message = payload.toString();
                        if (topic === mqttTopics.tempCommandTopic) {
                            const temp = parseFloat(message);
                            if (!isNaN(temp)) {
                                controller.setSetpoint(temp);
                                node.log('MQTT set temperature: ' + temp + '°C');
                                saveStateToFile(node.id, controller.getState());
                                publishMqttState();
                            }
                        } else if (topic === mqttTopics.modeCommandTopic) {
                            const mode = String(message).toLowerCase();
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
                                saveStateToFile(node.id, controller.getState());
                                publishMqttState();
                            }
                        } else if (topic === `climate/${uniqueId}/set_operating_mode`) {
                            const opMode = String(message).toLowerCase();
                            if (['manual', 'schedule', 'off'].includes(opMode)) {
                                controller.setOperatingMode(opMode);
                                node.log('MQTT set operating mode: ' + opMode);
                                saveStateToFile(node.id, controller.getState());
                                publishMqttState();
                            }
                        } else if (topic === `climate/${uniqueId}/set_away`) {
                            const val = message.toLowerCase();
                            if (val === 'true' || val === 'on') {
                                controller.setAwayMode(true);
                                node.log('MQTT away enabled');
                            } else if (val === 'false' || val === 'off') {
                                controller.setAwayMode(false);
                                node.log('MQTT away disabled');
                            } else {
                                const temp = parseFloat(val);
                                if (!isNaN(temp)) {
                                    controller.setAwayMode(temp);
                                    node.log('MQTT away set to ' + temp + '°C');
                                }
                            }
                            saveStateToFile(node.id, controller.getState());
                            publishMqttState();
                        } else if (topic === `climate/${uniqueId}/set_boost`) {
                            if (message === 'false' || message === 'off') {
                                controller.setBoost(false);
                                node.log('MQTT boost disabled');
                            } else {
                                try {
                                    const boost = JSON.parse(message);
                                    if (boost.temp && boost.duration) {
                                        controller.setBoost(boost);
                                        node.log('MQTT boost: ' + boost.temp + '°C for ' + boost.duration + 'min');
                                    }
                                } catch (e) {
                                    const temp = parseFloat(message);
                                    if (!isNaN(temp)) {
                                        controller.setBoost({temp: temp, duration: 60});
                                        node.log('MQTT boost: ' + temp + '°C for 60min');
                                    }
                                }
                            }
                            saveStateToFile(node.id, controller.getState());
                            publishMqttState();
                        }
                    } catch (err) {
                        node.error('MQTT message error: ' + err.message);
                        node.error(err.stack);
                    }
                });

                // Функция публикации состояния (объектный синтаксис)
                function publishMqttState() {
                    if (!mqttClient || !mqttTopics) return;
                    try {
                        const state = controller.getState();
                        const currentTemp = state.currentTemp;
                        const targetTemp = state.targetTemp;
                        const mode = state.mode;
                        const operatingMode = state.operatingMode;
                        const away = state.awayMode;
                        const boost = state.boostActive;
                        const result = controller.getStatus();
                        const percent = mapTemperatureToPercent(
                            result.output,
                            controllerConfig.minTemp,
                            controllerConfig.maxTemp,
                            analogConfig.outputMapping
                        );
                        const finalPercent = analogConfig.roundToInteger ? Math.round(percent) : percent;
                        const isActive = (operatingMode !== 'off') && (Math.abs(result.debug.error) > controllerConfig.hysteresis);

                        if (currentTemp !== null && currentTemp !== undefined) {
                            mqttClient.publish({ topic: mqttTopics.currentTempTopic, payload: String(currentTemp) });
                        }
                        if (targetTemp !== null && targetTemp !== undefined) {
                            mqttClient.publish({ topic: mqttTopics.targetTempTopic, payload: String(targetTemp) });
                        }
                        const pubMode = (operatingMode === 'off') ? 'off' : mode;
                        mqttClient.publish({ topic: mqttTopics.modeStateTopic, payload: pubMode });
                        mqttClient.publish({ topic: mqttTopics.analogOutputTopic, payload: String(finalPercent) });
                        mqttClient.publish({ topic: mqttTopics.activeTopic, payload: isActive ? 'ON' : 'OFF' });

                        const fullState = {
                            current_temperature: currentTemp,
                            target_temperature: targetTemp,
                            mode: pubMode,
                            operating_mode: operatingMode,
                            away: away,
                            boost: boost,
                            analog_output: finalPercent,
                            active: isActive,
                            pid: result.debug.pid,
                            error: result.debug.error,
                            trend: result.debug.trend
                        };
                        mqttClient.publish({ topic: mqttTopics.stateTopic, payload: JSON.stringify(fullState) });
                    } catch (err) {
                        node.error('publishMqttState error: ' + err.message);
                        node.error(err.stack);
                    }
                }

                node.publishMqttState = publishMqttState;

                // Отправка discovery (объектный синтаксис)
                if (config.mqttDiscovery !== false) {
                    const discoveryPayload = JSON.stringify(mqttTopics.config);
                    mqttClient.publish({ topic: mqttTopics.discoveryTopic, payload: discoveryPayload, retain: true });
                    node.log('MQTT Discovery published to ' + mqttTopics.discoveryTopic);

                    // Сенсор аналогового выхода
                    const sensorConfig = {
                        name: node.mqttDeviceName + ' Output',
                        unique_id: uniqueId + '_output',
                        device: mqttTopics.config.device,
                        state_topic: mqttTopics.analogOutputTopic,
                        unit_of_measurement: '%',
                        value_template: '{{ value }}',
                        icon: 'mdi:percent'
                    };
                    const sensorTopic = `${node.mqttBaseTopic || 'homeassistant'}/sensor/${uniqueId}_output/config`;
                    mqttClient.publish({ topic: sensorTopic, payload: JSON.stringify(sensorConfig), retain: true });
                    node.log('MQTT Discovery sensor published to ' + sensorTopic);

                    // Бинарный сенсор активности
                    const activeSensor = {
                        name: node.mqttDeviceName + ' Active',
                        unique_id: uniqueId + '_active',
                        device: mqttTopics.config.device,
                        state_topic: mqttTopics.activeTopic,
                        value_template: '{{ value }}',
                        icon: 'mdi:power'
                    };
                    const activeTopic = `${node.mqttBaseTopic || 'homeassistant'}/binary_sensor/${uniqueId}_active/config`;
                    mqttClient.publish({ topic: activeTopic, payload: JSON.stringify(activeSensor), retain: true });
                    node.log('MQTT Discovery binary_sensor published to ' + activeTopic);
                }

                // При закрытии узла (объектный синтаксис)
                node.on('close', function(removed, done) {
                    if (mqttClient && mqttTopics) {
                        const topics = [
                            mqttTopics.tempCommandTopic,
                            mqttTopics.modeCommandTopic,
                            `climate/${uniqueId}/set_operating_mode`,
                            `climate/${uniqueId}/set_away`,
                            `climate/${uniqueId}/set_boost`
                        ];
                        topics.forEach(t => {
                            mqttClient.unsubscribe({ topic: t }, (err) => {
                                if (err) node.warn('Failed to unsubscribe from ' + t);
                            });
                        });
                        if (config.mqttDiscovery !== false) {
                            mqttClient.publish({ topic: mqttTopics.discoveryTopic, payload: '', retain: true });
                            const sensorTopic = `${node.mqttBaseTopic || 'homeassistant'}/sensor/${uniqueId}_output/config`;
                            mqttClient.publish({ topic: sensorTopic, payload: '', retain: true });
                            const activeTopic = `${node.mqttBaseTopic || 'homeassistant'}/binary_sensor/${uniqueId}_active/config`;
                            mqttClient.publish({ topic: activeTopic, payload: '', retain: true });
                        }
                    }
                    saveStateToFile(node.id, controller.getState());
                    node.log('Controller state saved to file');
                    if (done) done();
                });
            } else {
                node.warn('MQTT broker node not found: ' + config.mqttBroker);
            }
        }

        // ========== Вспомогательные функции ==========
        function mapTemperatureToPercent(temp, minTemp, maxTemp, mapping) {
            if (maxTemp === minTemp) return 50;
            let percent = ((temp - minTemp) / (maxTemp - minTemp)) * 100;
            percent = Math.max(0, Math.min(100, percent));
            if (mapping === 'inverse') {
                percent = 100 - percent;
            }
            return percent;
        }

        // ========== Обновление статуса ==========
        function updateStatus(result) {
            const state = result.debug.state;
            const error = result.debug.error;
            const trend = result.debug.trend;
            const operatingMode = result.debug.operatingMode;
            const boostActive = result.debug.boostActive;
            const awayMode = result.debug.awayMode;
            const activeMode = result.debug.activeMode || 'heat';

            let fill = 'grey';
            let shape = 'ring';
            let text = '';

            let prefix = '';
            if (boostActive) {
                prefix = ` BOOST (${result.debug.boostRemaining}m) `;
                fill = 'yellow';
                shape = 'dot';
            } else if (awayMode) {
                prefix = ' AWAY ';
            }

            if (operatingMode === 'off') {
                fill = 'grey';
                shape = 'ring';
                node.status({ fill, shape, text: '⏹ OFF' });
                if (node.publishMqttState) node.publishMqttState();
                return;
            }

            if (state === 'learning') {
                fill = boostActive ? 'yellow' : 'yellow';
                shape = 'dot';
                const setpointIcon = activeMode === 'heat' ? '🔥' : '❄️';
                const percent = Math.round(mapTemperatureToPercent(result.output, controllerConfig.minTemp, controllerConfig.maxTemp, analogConfig.outputMapping));
                text = `${prefix}Обучение... ${result.debug.currentTemp}°C → ${result.debug.targetTemp}°C → ${setpointIcon} ${percent}%`;
            } else if (trend === 'idle') {
                fill = boostActive ? 'yellow' : 'grey';
                const percent = Math.round(mapTemperatureToPercent(result.output, controllerConfig.minTemp, controllerConfig.maxTemp, analogConfig.outputMapping));
                text = `${prefix}Ожидание ${result.debug.currentTemp}°C (${percent}%)`;
            } else if (trend === 'off') {
                fill = 'grey';
                text = '⏹ OFF';
            } else {
                if (Math.abs(error) < controllerConfig.hysteresis) {
                    fill = boostActive ? 'yellow' : 'green';
                    const percent = Math.round(mapTemperatureToPercent(result.output, controllerConfig.minTemp, controllerConfig.maxTemp, analogConfig.outputMapping));
                    text = `${prefix}✅ ${result.debug.currentTemp}°C → ${result.debug.targetTemp}°C (${percent}%)`;
                } else if (activeMode === 'heat') {
                    fill = boostActive ? 'yellow' : 'red';
                    const percent = Math.round(mapTemperatureToPercent(result.output, controllerConfig.minTemp, controllerConfig.maxTemp, analogConfig.outputMapping));
                    text = `${prefix}🔥 ${result.debug.currentTemp}°C → ${result.debug.targetTemp}°C → ${percent}%`;
                } else {
                    fill = boostActive ? 'yellow' : 'blue';
                    const percent = Math.round(mapTemperatureToPercent(result.output, controllerConfig.minTemp, controllerConfig.maxTemp, analogConfig.outputMapping));
                    text = `${prefix}❄️ ${result.debug.currentTemp}°C → ${result.debug.targetTemp}°C → ${percent}%`;
                }
            }
            node.status({ fill, shape, text });

            if (node.publishMqttState) node.publishMqttState();
        }

        // ========== Обработка входящих сообщений ==========
        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            try {
                let stateChanged = false;

                if (msg.schedule !== undefined) {
                    controller.setSchedule(msg.schedule);
                    stateChanged = true;
                    node.log('Schedule updated via msg');
                }
                if (msg.boost !== undefined) {
                    controller.setBoost(msg.boost);
                    if (msg.boost === false) {
                        node.log('Boost mode disabled via msg');
                    } else if (msg.boost && msg.boost.temp && msg.boost.duration) {
                        node.log(`Boost mode: ${msg.boost.temp}°C for ${msg.boost.duration} minutes via msg`);
                    }
                    stateChanged = true;
                }
                if (msg.away !== undefined) {
                    controller.setAwayMode(msg.away);
                    node.log(`Away mode: ${msg.away === false ? 'disabled' : 'enabled'} via msg`);
                    stateChanged = true;
                }
                if (msg.operatingMode !== undefined) {
                    const newOpMode = String(msg.operatingMode).toLowerCase();
                    if (['manual', 'schedule', 'off'].includes(newOpMode)) {
                        controller.setOperatingMode(newOpMode);
                        stateChanged = true;
                        node.log(`Operating mode changed to ${newOpMode} via msg`);
                    }
                }
                if (msg.setpoint !== undefined) {
                    const newSetpoint = parseFloat(msg.setpoint);
                    if (!isNaN(newSetpoint)) {
                        controller.setSetpoint(newSetpoint);
                        node.log(`Setpoint changed to ${newSetpoint}°C via msg`);
                        stateChanged = true;
                    }
                }
                if (msg.mode !== undefined) {
                    const newMode = String(msg.mode).toLowerCase();
                    const legacyMap = { 'heating': 'heat', 'cooling': 'cool', 'auto': 'heat_cool' };
                    const normalizedNewMode = legacyMap[newMode] || newMode;
                    if (['heat', 'cool', 'heat_cool'].includes(normalizedNewMode)) {
                        controller.setMode(normalizedNewMode);
                        node.log(`Mode changed to ${normalizedNewMode} via msg`);
                        stateChanged = true;
                    }
                }

                if (stateChanged) {
                    saveStateToFile(node.id, controller.getState());
                }

                const currentTemp = parseFloat(msg.payload);
                const configChanged = stateChanged ||
                    msg.boost !== undefined ||
                    msg.away !== undefined ||
                    msg.operatingMode !== undefined ||
                    msg.setpoint !== undefined ||
                    msg.mode !== undefined;

                if (isNaN(currentTemp)) {
                    if (configChanged) {
                        controller.syncSchedule();
                        if (controller.currentTemp !== null) {
                            const result = controller.getStatus();
                            updateStatus(result);
                        }
                    }
                    if (done) done();
                    return;
                }

                const result = controller.update(currentTemp);

                if (controller.hasParametersChanged()) {
                    saveStateToFile(node.id, controller.getState());
                    node.log('PID parameters updated and saved (Kp=' + result.debug.pid.Kp +
                        ', Ki=' + result.debug.pid.Ki + ', Kd=' + result.debug.pid.Kd + ')');
                }

                updateStatus(result);

                const activeMode = result.debug.activeMode;
                const error = result.debug.error;
                const operatingMode = result.debug.operatingMode;
                const hysteresis = controllerConfig.hysteresis;
                let isActive = false;

                if (operatingMode === 'off') {
                    wasHeatingActive = false;
                    wasCoolingActive = false;
                    isActive = false;
                } else if (activeMode === 'heat') {
                    const setpointAboveTarget = result.output > result.debug.targetTemp + controllerConfig.precision;
                    const tempFalling = result.debug.trend === 'cooling';
                    if (error > hysteresis) {
                        wasHeatingActive = true;
                    } else if (setpointAboveTarget && tempFalling && error > 0) {
                        wasHeatingActive = true;
                    } else if (error <= 0) {
                        wasHeatingActive = false;
                    }
                    isActive = wasHeatingActive;
                } else if (activeMode === 'cool') {
                    const setpointBelowTarget = result.output < result.debug.targetTemp - controllerConfig.precision;
                    const tempRising = result.debug.trend === 'warming';
                    if (error < -hysteresis) {
                        wasCoolingActive = true;
                    } else if (setpointBelowTarget && tempRising && error < 0) {
                        wasCoolingActive = true;
                    } else if (error >= 0) {
                        wasCoolingActive = false;
                    }
                    isActive = wasCoolingActive;
                }

                const percent = mapTemperatureToPercent(
                    result.output,
                    controllerConfig.minTemp,
                    controllerConfig.maxTemp,
                    analogConfig.outputMapping
                );
                const finalPercent = analogConfig.roundToInteger ? Math.round(percent) : percent;

                const msg1 = {
                    payload: finalPercent,
                    topic: msg.topic || 'thermostat/analog'
                };

                const msg2 = {
                    payload: result.debug,
                    topic: msg.topic ? msg.topic + '/debug' : 'thermostat/debug'
                };

                const msg3 = {
                    payload: isActive,
                    topic: msg.topic ? msg.topic + '/active' : 'thermostat/active'
                };

                send([msg1, msg2, msg3]);

                if (done) done();
            } catch (err) {
                node.error('Error in input handler: ' + err.message);
                node.error(err.stack);
                if (done) done(err);
            }
        });

        node.on('close', function(removed, done) {
            saveStateToFile(node.id, controller.getState());
            node.log('Controller state saved to file (close)');
            if (done) done();
        });
    }

    RED.nodes.registerType('analog-thermostat', AnalogThermostatNode);
};
