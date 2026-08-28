// =============================================================================
// analog-thermostat.js
// Адаптация оригинального smart-thermostat.js от WojRep
// Выход: 0-100% вместо температуры
// MQTT: нативный клиент (как в оригинале)
// =============================================================================

const AdaptiveController = require('../lib/adaptive-controller');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');   // <--- нативная библиотека

module.exports = function(RED) {
    function AnalogThermostatNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.log('===== ANALOG THERMOSTAT VERSION 1.0.36 (NATIVE MQTT) =====');

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

        // ---------- Контроллер (оригинал) ----------
        const controller = new AdaptiveController(controllerConfig);
        let wasHeatingActive = false;
        let wasCoolingActive = false;

        // ---------- Работа с состоянием (оригинал) ----------
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

        // ---------- MQTT (нативный клиент, как в оригинале) ----------
        let mqttClient = null;
        const uniqueId = config.mqttUniqueId || 'analog_thermostat_' + node.id;
        const baseTopic = config.mqttBaseTopic || 'homeassistant';

        // Параметры подключения к брокеру (берём из конфига узла MQTT, если он есть)
        let brokerUrl = null;
        let mqttOptions = {};
        if (config.mqttBroker) {
            const brokerNode = RED.nodes.getNode(config.mqttBroker);
            if (brokerNode) {
                brokerUrl = brokerNode.brokerurl || brokerNode.url;
                mqttOptions = {
                    clientId: brokerNode.clientid || 'analog-thermostat-' + uniqueId,
                    username: brokerNode.username || '',
                    password: brokerNode.password || '',
                    keepalive: brokerNode.keepalive || 60,
                    rejectUnauthorized: brokerNode.rejectUnauthorized !== false
                };
                node.log('MQTT broker URL: ' + brokerUrl);
            }
        }

        // Если URL не найден, используем настройки по умолчанию (можно задать в конфиге)
        if (!brokerUrl) {
            brokerUrl = config.mqttBrokerUrl || 'mqtt://localhost:1883';
            node.warn('Using fallback broker URL: ' + brokerUrl);
        }

        if (brokerUrl) {
            try {
                mqttClient = mqtt.connect(brokerUrl, mqttOptions);
                mqttClient.on('connect', () => {
                    node.log('MQTT connected to ' + brokerUrl);

                    // ----- Публикация Discovery (как в оригинале) -----
                    if (config.mqttDiscovery !== false) {
                        const device = {
                            identifiers: [uniqueId],
                            name: config.mqttDeviceName || 'Analog Thermostat',
                            manufacturer: config.mqttManufacturer || 'Node-RED',
                            model: config.mqttModel || 'Analog Thermostat',
                            sw_version: '1.0.0'
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
                        const discoveryTopic = `${baseTopic}/climate/${uniqueId}/config`;
                        mqttClient.publish(discoveryTopic, JSON.stringify(climateConfig), { retain: true });
                        node.log('MQTT Discovery published to ' + discoveryTopic);

                        // Сенсор аналогового выхода
                        const sensorConfig = {
                            name: config.mqttDeviceName + ' Output',
                            unique_id: uniqueId + '_output',
                            device: device,
                            state_topic: `climate/${uniqueId}/analog_output`,
                            unit_of_measurement: '%',
                            value_template: '{{ value }}',
                            icon: 'mdi:percent'
                        };
                        const sensorTopic = `${baseTopic}/sensor/${uniqueId}_output/config`;
                        mqttClient.publish(sensorTopic, JSON.stringify(sensorConfig), { retain: true });

                        // Бинарный сенсор активности
                        const binaryConfig = {
                            name: config.mqttDeviceName + ' Active',
                            unique_id: uniqueId + '_active',
                            device: device,
                            state_topic: `climate/${uniqueId}/active`,
                            payload_on: 'ON',
                            payload_off: 'OFF',
                            icon: 'mdi:power'
                        };
                        const binaryTopic = `${baseTopic}/binary_sensor/${uniqueId}_active/config`;
                        mqttClient.publish(binaryTopic, JSON.stringify(binaryConfig), { retain: true });
                    }

                    // ----- Подписки на команды -----
                    const commandTopics = [
                        `climate/${uniqueId}/set_temp`,
                        `climate/${uniqueId}/set_mode`,
                        `climate/${uniqueId}/set_operating_mode`,
                        `climate/${uniqueId}/set_away`,
                        `climate/${uniqueId}/set_boost`
                    ];
                    commandTopics.forEach(topic => {
                        mqttClient.subscribe(topic, (err) => {
                            if (err) node.warn('Failed to subscribe to ' + topic + ': ' + err);
                            else node.log('Subscribed to ' + topic);
                        });
                    });
                });

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

                mqttClient.on('error', (err) => {
                    node.error('MQTT error: ' + err.message);
                });

                // ----- Функция публикации состояния (как в оригинале: три аргумента) -----
                function publishMqttState() {
                    if (!mqttClient || !mqttClient.connected) return;
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

                        const currentTempTopic = `climate/${uniqueId}/current_temp`;
                        const targetTempTopic = `climate/${uniqueId}/target_temp`;
                        const modeTopic = `climate/${uniqueId}/mode`;
                        const analogOutputTopic = `climate/${uniqueId}/analog_output`;
                        const activeTopic = `climate/${uniqueId}/active`;
                        const stateTopic = `climate/${uniqueId}/state`;

                        if (currentTemp !== null && currentTemp !== undefined) {
                            mqttClient.publish(currentTempTopic, String(currentTemp), { retain: true });
                        }
                        if (targetTemp !== null && targetTemp !== undefined) {
                            mqttClient.publish(targetTempTopic, String(targetTemp), { retain: true });
                        }
                        mqttClient.publish(modeTopic, (operatingMode === 'off') ? 'off' : mode, { retain: true });
                        mqttClient.publish(analogOutputTopic, String(finalPercent), { retain: true });
                        mqttClient.publish(activeTopic, isActive ? 'ON' : 'OFF', { retain: true });

                        const fullState = {
                            current_temperature: currentTemp,
                            target_temperature: targetTemp,
                            mode: (operatingMode === 'off') ? 'off' : mode,
                            operating_mode: operatingMode,
                            away: state.awayMode,
                            boost: state.boostActive,
                            analog_output: finalPercent,
                            active: isActive,
                            pid: result.debug.pid,
                            error: result.debug.error,
                            trend: result.debug.trend
                        };
                        mqttClient.publish(stateTopic, JSON.stringify(fullState), { retain: true });
                    } catch (err) {
                        node.error('publishMqttState error: ' + err.message);
                    }
                }

                // Экспортируем функцию для вызова из других мест
                node.publishMqttState = publishMqttState;

                // ----- Закрытие (отписка и очистка) -----
                node.on('close', function(removed, done) {
                    if (mqttClient) {
                        mqttClient.end(true, () => {
                            node.log('MQTT disconnected');
                            if (done) done();
                        });
                    } else {
                        if (done) done();
                    }
                    saveStateToFile(node.id, controller.getState());
                    node.log('Controller state saved');
                });

            } catch (err) {
                node.error('Failed to connect MQTT: ' + err.message);
            }
        } else {
            node.warn('MQTT broker not configured');
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

        // ---------- Обновление статуса узла (упрощённо) ----------
        function updateStatus(result) {
            const percent = Math.round(
                mapTemperatureToPercent(
                    result.output,
                    controllerConfig.minTemp,
                    controllerConfig.maxTemp,
                    analogConfig.outputMapping
                )
            );
            const activeMode = result.debug.activeMode || 'heat';
            const icon = activeMode === 'heat' ? '🔥' : '❄️';
            node.status({ fill: 'green', shape: 'dot', text: `${icon} ${percent}%` });
        }

        // ---------- Обработчик входных сообщений (как в оригинале) ----------
        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            try {
                let stateChanged = false;

                // Обработка команд через msg (setpoint, mode, operatingMode, away, boost, schedule)
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
                    node.log('PID parameters updated and saved');
                }

                // Публикуем состояние через MQTT
                if (node.publishMqttState) node.publishMqttState();

                // Обновляем статус узла
                updateStatus(result);

                // Формируем выходные сообщения
                const percent = mapTemperatureToPercent(
                    result.output,
                    controllerConfig.minTemp,
                    controllerConfig.maxTemp,
                    analogConfig.outputMapping
                );
                const finalPercent = analogConfig.roundToInteger ? Math.round(percent) : percent;
                const isActive = (controller.operatingMode !== 'off') && (Math.abs(result.debug.error) > controllerConfig.hysteresis);

                const msg1 = { payload: finalPercent, topic: msg.topic || 'thermostat/analog' };
                const msg2 = { payload: result.debug, topic: msg.topic ? msg.topic + '/debug' : 'thermostat/debug' };
                const msg3 = { payload: isActive, topic: msg.topic ? msg.topic + '/active' : 'thermostat/active' };

                send([msg1, msg2, msg3]);

                if (done) done();
            } catch (err) {
                node.error('Input error: ' + err.message);
                if (done) done(err);
            }
        });

        // ---------- Закрытие (дополнительно) ----------
        node.on('close', function(removed, done) {
            saveStateToFile(node.id, controller.getState());
            node.log('Controller state saved (close)');
            if (done) done();
        });
    }

    RED.nodes.registerType('analog-thermostat', AnalogThermostatNode);
};
