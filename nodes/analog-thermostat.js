const AdaptiveController = require('../lib/adaptive-controller');
const fs = require('fs');
const path = require('path');

module.exports = function(RED) {
    function AnalogThermostatNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // ---- Параметры ----
        const minTemp = parseFloat(config.minTemp) || 15;
        const maxTemp = parseFloat(config.maxTemp) || 25;
        const targetTemp = parseFloat(config.targetTemp) || 21;
        const hysteresis = parseFloat(config.hysteresis) || 0.2;
        const sampleInterval = (parseFloat(config.sampleInterval) || 60) * 1000;
        const learningEnabled = config.learningEnabled !== false;
        const maxOutputChange = parseFloat(config.maxOutputChange) || 0.5;
        const precision = parseFloat(config.precision) || 0.5;
        const mode = config.mode || 'heat';
        const operatingMode = config.operatingMode || 'manual';
        const awayTemp = parseFloat(config.awayTemp) || 16;

        const controllerConfig = {
            minTemp, maxTemp, targetTemp, hysteresis, sampleInterval,
            learningEnabled, maxOutputChange, precision,
            mode, operatingMode, awayTemp
        };

        const controller = new AdaptiveController(controllerConfig);

        // ---- Состояние гистерезиса ----
        let wasHeatingActive = false;
        let wasCoolingActive = false;

        // ---- Восстановление состояния из контекста ----
        const savedState = node.context().get('controllerState');
        if (savedState) {
            controller.setState(savedState);
            node.log('Restored controller state');
        }

        // ---- MQTT ----
        const mqttBrokerNode = config.mqttBroker ? RED.nodes.getNode(config.mqttBroker) : null;
        let mqttClient = null;
        let mqttTopics = null;
        const uniqueId = config.mqttUniqueId || 'analog_thermostat_' + node.id;

        if (mqttBrokerNode) {
            mqttClient = mqttBrokerNode;
            node.log('MQTT broker connected');

            // Формируем топики
            const baseTopic = config.mqttBaseTopic || 'homeassistant';
            mqttTopics = {
                discoveryTopic: `${baseTopic}/climate/${uniqueId}/config`,
                stateTopic: `climate/${uniqueId}/state`,
                currentTempTopic: `climate/${uniqueId}/current_temp`,
                targetTempTopic: `climate/${uniqueId}/target_temp`,
                modeStateTopic: `climate/${uniqueId}/mode`,
                analogOutputTopic: `climate/${uniqueId}/analog_output`,
                activeTopic: `climate/${uniqueId}/active`,
                tempCommandTopic: `climate/${uniqueId}/set_temp`,
                modeCommandTopic: `climate/${uniqueId}/set_mode`,
                opModeCommandTopic: `climate/${uniqueId}/set_operating_mode`,
                awayCommandTopic: `climate/${uniqueId}/set_away`,
                boostCommandTopic: `climate/${uniqueId}/set_boost`
            };

            // Подписка на команды
            const subscribeTopics = [
                mqttTopics.tempCommandTopic,
                mqttTopics.modeCommandTopic,
                mqttTopics.opModeCommandTopic,
                mqttTopics.awayCommandTopic,
                mqttTopics.boostCommandTopic
            ];
            subscribeTopics.forEach(topic => {
                mqttClient.subscribe(topic, (err) => {
                    if (err) node.warn('Failed to subscribe to ' + topic + ': ' + err);
                    else node.log('Subscribed to ' + topic);
                });
            });

            // Обработчик сообщений
            mqttClient.on('message', (topic, payload) => {
                try {
                    const message = payload.toString();
                    if (topic === mqttTopics.tempCommandTopic) {
                        const temp = parseFloat(message);
                        if (!isNaN(temp)) {
                            controller.setSetpoint(temp);
                            node.log('MQTT set temp: ' + temp);
                            saveStateAndPublish();
                        }
                    } else if (topic === mqttTopics.modeCommandTopic) {
                        const modeMap = { 'heating': 'heat', 'cooling': 'cool', 'auto': 'heat_cool', 'off': 'off' };
                        const newMode = modeMap[message] || message;
                        if (['heat', 'cool', 'heat_cool', 'off'].includes(newMode)) {
                            if (newMode === 'off') {
                                controller.setOperatingMode('off');
                            } else {
                                controller.setMode(newMode);
                                if (controller.operatingMode === 'off') controller.setOperatingMode('manual');
                            }
                            node.log('MQTT set mode: ' + newMode);
                            saveStateAndPublish();
                        }
                    } else if (topic === mqttTopics.opModeCommandTopic) {
                        const opMode = String(message).toLowerCase();
                        if (['manual', 'schedule', 'off'].includes(opMode)) {
                            controller.setOperatingMode(opMode);
                            node.log('MQTT set operating mode: ' + opMode);
                            saveStateAndPublish();
                        }
                    } else if (topic === mqttTopics.awayCommandTopic) {
                        if (message === 'true' || message === 'on') {
                            controller.setAwayMode(true);
                            node.log('MQTT away on');
                        } else if (message === 'false' || message === 'off') {
                            controller.setAwayMode(false);
                            node.log('MQTT away off');
                        } else {
                            const temp = parseFloat(message);
                            if (!isNaN(temp)) {
                                controller.setAwayMode(temp);
                                node.log('MQTT away temp: ' + temp);
                            }
                        }
                        saveStateAndPublish();
                    } else if (topic === mqttTopics.boostCommandTopic) {
                        if (message === 'false' || message === 'off') {
                            controller.setBoost(false);
                            node.log('MQTT boost off');
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
                                    node.log('MQTT boost temp: ' + temp + '°C for 60min');
                                }
                            }
                        }
                        saveStateAndPublish();
                    }
                } catch (err) {
                    node.error('MQTT message error: ' + err.message);
                }
            });

            // Публикация Discovery
            if (config.mqttDiscovery !== false) {
                const deviceConfig = {
                    name: config.mqttDeviceName || 'Analog Thermostat',
                    unique_id: uniqueId,
                    device: {
                        identifiers: [uniqueId],
                        name: config.mqttDeviceName || 'Analog Thermostat',
                        manufacturer: config.mqttManufacturer || 'Node-RED',
                        model: config.mqttModel || 'Analog Thermostat',
                        sw_version: '1.0.0'
                    },
                    current_temperature_topic: mqttTopics.currentTempTopic,
                    temperature_command_topic: mqttTopics.tempCommandTopic,
                    temperature_state_topic: mqttTopics.targetTempTopic,
                    mode_command_topic: mqttTopics.modeCommandTopic,
                    mode_state_topic: mqttTopics.modeStateTopic,
                    modes: ['heat', 'cool', 'heat_cool', 'off'],
                    min_temp: minTemp,
                    max_temp: maxTemp,
                    temp_step: precision,
                    retain: false
                };
                const discoveryPayload = JSON.stringify(deviceConfig);
                mqttClient.publish(mqttTopics.discoveryTopic, discoveryPayload, { retain: true });
                node.log('MQTT Discovery published to ' + mqttTopics.discoveryTopic);

                // Дополнительные сенсоры
                const sensorConfig = {
                    name: (config.mqttDeviceName || 'Analog Thermostat') + ' Output',
                    unique_id: uniqueId + '_output',
                    device: deviceConfig.device,
                    state_topic: mqttTopics.analogOutputTopic,
                    unit_of_measurement: '%',
                    icon: 'mdi:percent'
                };
                const sensorTopic = `${baseTopic}/sensor/${uniqueId}_output/config`;
                mqttClient.publish(sensorTopic, JSON.stringify(sensorConfig), { retain: true });

                const binarySensorConfig = {
                    name: (config.mqttDeviceName || 'Analog Thermostat') + ' Active',
                    unique_id: uniqueId + '_active',
                    device: deviceConfig.device,
                    state_topic: mqttTopics.activeTopic,
                    icon: 'mdi:power'
                };
                const binaryTopic = `${baseTopic}/binary_sensor/${uniqueId}_active/config`;
                mqttClient.publish(binaryTopic, JSON.stringify(binarySensorConfig), { retain: true });
            }

            // Функция публикации состояния
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

                    // Вычисляем аналоговый выход
                    const result = controller.getStatus();
                    const percent = mapTemperatureToPercent(result.output, minTemp, maxTemp, config.outputMapping || 'direct');
                    const finalPercent = config.roundToInteger !== false ? Math.round(percent) : percent;

                    // Публикуем
                    if (currentTemp !== undefined && currentTemp !== null) {
                        mqttClient.publish(mqttTopics.currentTempTopic, String(currentTemp));
                    }
                    if (targetTemp !== undefined && targetTemp !== null) {
                        mqttClient.publish(mqttTopics.targetTempTopic, String(targetTemp));
                    }
                    const pubMode = (operatingMode === 'off') ? 'off' : mode;
                    mqttClient.publish(mqttTopics.modeStateTopic, pubMode);
                    mqttClient.publish(mqttTopics.analogOutputTopic, String(finalPercent));
                    const isActive = (operatingMode !== 'off') && (Math.abs(result.debug.error) > hysteresis);
                    mqttClient.publish(mqttTopics.activeTopic, isActive ? 'ON' : 'OFF');

                    // Общее состояние JSON
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
                    mqttClient.publish(mqttTopics.stateTopic, JSON.stringify(fullState));
                } catch (err) {
                    node.error('publishMqttState error: ' + err.message);
                }
            }

            // Сохраняем ссылку
            node.publishMqttState = publishMqttState;
            node.mqttTopics = mqttTopics;
            node.mqttClient = mqttClient;

            // Функция сохранения и публикации
            function saveStateAndPublish() {
                node.context().set('controllerState', controller.getState());
                if (node.publishMqttState) node.publishMqttState();
            }

            // При закрытии отписываемся
            node.on('close', function(removed, done) {
                if (mqttClient && mqttTopics) {
                    const topics = [
                        mqttTopics.tempCommandTopic,
                        mqttTopics.modeCommandTopic,
                        mqttTopics.opModeCommandTopic,
                        mqttTopics.awayCommandTopic,
                        mqttTopics.boostCommandTopic
                    ];
                    topics.forEach(t => {
                        mqttClient.unsubscribe(t, (err) => {
                            if (err) node.warn('Unsubscribe error: ' + err);
                        });
                    });
                    // Удаляем discovery
                    if (config.mqttDiscovery !== false) {
                        mqttClient.publish(mqttTopics.discoveryTopic, '', { retain: true });
                        const sensorTopic = `${config.mqttBaseTopic || 'homeassistant'}/sensor/${uniqueId}_output/config`;
                        mqttClient.publish(sensorTopic, '', { retain: true });
                        const binaryTopic = `${config.mqttBaseTopic || 'homeassistant'}/binary_sensor/${uniqueId}_active/config`;
                        mqttClient.publish(binaryTopic, '', { retain: true });
                    }
                }
                node.context().set('controllerState', controller.getState());
                if (done) done();
            });
        }

        // ---- Вспомогательная функция маппинга ----
        function mapTemperatureToPercent(temp, minTemp, maxTemp, mapping) {
            if (maxTemp === minTemp) return 50;
            let percent = ((temp - minTemp) / (maxTemp - minTemp)) * 100;
            percent = Math.max(0, Math.min(100, percent));
            if (mapping === 'inverse') {
                percent = 100 - percent;
            }
            return percent;
        }

        // ---- Обновление статуса узла ----
        function updateStatus(result) {
            const currentTemp = result.debug.currentTemp;
            const targetTemp = result.debug.targetTemp;
            const error = result.debug.error;
            const operatingMode = result.debug.operatingMode;
            const boostActive = result.debug.boostActive;
            const awayMode = result.debug.awayMode;
            const activeMode = result.debug.activeMode || 'heat';
            const percent = mapTemperatureToPercent(result.output, minTemp, maxTemp, config.outputMapping || 'direct');
            const finalPercent = config.roundToInteger !== false ? Math.round(percent) : percent;

            let fill = 'grey';
            let shape = 'ring';
            let text = '';

            let prefix = '';
            if (boostActive) {
                prefix = `BOOST (${result.debug.boostRemaining}m) `;
                fill = 'yellow';
                shape = 'dot';
            } else if (awayMode) {
                prefix = 'AWAY ';
            }

            if (operatingMode === 'off') {
                fill = 'grey';
                shape = 'ring';
                node.status({ fill, shape, text: '⏹ OFF' });
                return;
            }

            if (result.debug.state === 'learning') {
                fill = 'yellow';
                shape = 'dot';
                text = `${prefix}Обучение... ${currentTemp}°C → ${targetTemp}°C → ${finalPercent}%`;
            } else if (Math.abs(error) < hysteresis) {
                fill = boostActive ? 'yellow' : 'green';
                text = `${prefix}✅ ${currentTemp}°C → ${targetTemp}°C (${finalPercent}%)`;
            } else if (activeMode === 'heat') {
                fill = boostActive ? 'yellow' : 'red';
                text = `${prefix}🔥 ${currentTemp}°C → ${targetTemp}°C → ${finalPercent}%`;
            } else if (activeMode === 'cool') {
                fill = boostActive ? 'yellow' : 'blue';
                text = `${prefix}❄️ ${currentTemp}°C → ${targetTemp}°C → ${finalPercent}%`;
            } else {
                fill = 'grey';
                text = `${prefix}${currentTemp}°C → ${targetTemp}°C (${finalPercent}%)`;
            }
            node.status({ fill, shape, text });
        }

        // ---- Обработка входных сообщений ----
        node.on('input', function(msg, send, done) {
            try {
                // Обработка управляющих сообщений
                let stateChanged = false;
                if (msg.schedule !== undefined) {
                    controller.setSchedule(msg.schedule);
                    stateChanged = true;
                }
                if (msg.boost !== undefined) {
                    controller.setBoost(msg.boost);
                    stateChanged = true;
                }
                if (msg.away !== undefined) {
                    controller.setAwayMode(msg.away);
                    stateChanged = true;
                }
                if (msg.operatingMode !== undefined) {
                    const opMode = String(msg.operatingMode).toLowerCase();
                    if (['manual', 'schedule', 'off'].includes(opMode)) {
                        controller.setOperatingMode(opMode);
                        stateChanged = true;
                    }
                }
                if (msg.setpoint !== undefined) {
                    const sp = parseFloat(msg.setpoint);
                    if (!isNaN(sp)) {
                        controller.setSetpoint(sp);
                        stateChanged = true;
                    }
                }
                if (msg.mode !== undefined) {
                    const modeMap = { 'heating': 'heat', 'cooling': 'cool', 'auto': 'heat_cool' };
                    const newMode = modeMap[String(msg.mode).toLowerCase()] || String(msg.mode).toLowerCase();
                    if (['heat', 'cool', 'heat_cool'].includes(newMode)) {
                        controller.setMode(newMode);
                        stateChanged = true;
                    }
                }

                if (stateChanged) {
                    node.context().set('controllerState', controller.getState());
                    if (node.publishMqttState) node.publishMqttState();
                }

                // Получение температуры
                const currentTemp = parseFloat(msg.payload);
                if (isNaN(currentTemp)) {
                    if (stateChanged) {
                        // Просто обновляем статус
                        const result = controller.getStatus();
                        updateStatus(result);
                        if (node.publishMqttState) node.publishMqttState();
                    }
                    if (done) done();
                    return;
                }

                // Основной расчёт
                const result = controller.update(currentTemp);
                // Сохраняем состояние
                node.context().set('controllerState', controller.getState());

                // Обновляем статус
                updateStatus(result);
                // Публикуем MQTT
                if (node.publishMqttState) node.publishMqttState();

                // ---- Определение активности ----
                const error = result.debug.error;
                const activeMode = result.debug.activeMode;
                const opMode = result.debug.operatingMode;
                let isActive = false;
                if (opMode !== 'off') {
                    if (activeMode === 'heat') {
                        if (error > hysteresis) {
                            wasHeatingActive = true;
                        } else if (error <= 0) {
                            wasHeatingActive = false;
                        }
                        isActive = wasHeatingActive;
                    } else if (activeMode === 'cool') {
                        if (error < -hysteresis) {
                            wasCoolingActive = true;
                        } else if (error >= 0) {
                            wasCoolingActive = false;
                        }
                        isActive = wasCoolingActive;
                    }
                }

                // ---- Формирование выходных сообщений ----
                const percent = mapTemperatureToPercent(result.output, minTemp, maxTemp, config.outputMapping || 'direct');
                const finalPercent = config.roundToInteger !== false ? Math.round(percent) : percent;

                const msg1 = { payload: finalPercent, topic: msg.topic || 'thermostat/analog' };
                const msg2 = { payload: result.debug, topic: msg.topic ? msg.topic + '/debug' : 'thermostat/debug' };
                const msg3 = { payload: isActive, topic: msg.topic ? msg.topic + '/active' : 'thermostat/active' };

                // Отправка через send или node.send
                if (typeof send === 'function') {
                    send([msg1, msg2, msg3]);
                } else {
                    node.send([msg1, msg2, msg3]);
                }

                if (done) done();

            } catch (err) {
                node.error('input error: ' + err.message);
                node.error(err.stack);
                if (done) done(err);
            }
        });

        // Закрытие
        node.on('close', function(removed, done) {
            node.context().set('controllerState', controller.getState());
            if (done) done();
        });
    }

    RED.nodes.registerType('analog-thermostat', AnalogThermostatNode);
};
