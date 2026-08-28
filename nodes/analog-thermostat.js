const AdaptiveController = require('../lib/adaptive-controller');
const fs = require('fs');
const path = require('path');

module.exports = function(RED) {
    function SmartThermostatNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        // ---------- Параметры (без изменений) ----------
        var modeMap = { 'heating': 'heat', 'cooling': 'cool', 'auto': 'heat_cool' };
        var configMode = config.mode || 'heat';
        var normalizedMode = modeMap[configMode] || configMode;

        var controllerConfig = {
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

        // Настройки для аналогового выхода (добавлены, но используются только для вычисления процента)
        var analogConfig = {
            outputMapping: config.outputMapping || 'direct',
            roundToInteger: config.roundToInteger !== false
        };

        var controller = new AdaptiveController(controllerConfig);
        var wasHeatingActive = false;
        var wasCoolingActive = false;

        // ---------- Восстановление состояния (как в оригинале) ----------
        var userDir = RED.settings.userDir || process.env.HOME || process.env.USERPROFILE;
        var storageDir = path.join(userDir, '.analog-thermostat');
        if (!fs.existsSync(storageDir)) {
            try { fs.mkdirSync(storageDir, { recursive: true }); } catch (err) {
                node.warn('Could not create storage directory: ' + err.message);
            }
        }
        function getStateFilePath(nodeId) {
            return path.join(storageDir, `state-${nodeId}.json`);
        }
        function loadStateFromFile(nodeId) {
            var filePath = getStateFilePath(nodeId);
            try {
                if (fs.existsSync(filePath)) {
                    var data = fs.readFileSync(filePath, 'utf8');
                    return JSON.parse(data);
                }
            } catch (err) {
                node.warn('Could not load state: ' + err.message);
            }
            return null;
        }
        function saveStateToFile(nodeId, state) {
            var filePath = getStateFilePath(nodeId);
            try {
                fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
            } catch (err) {
                node.warn('Could not save state: ' + err.message);
            }
        }

        var savedState = loadStateFromFile(node.id);
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
            var scheduleWithTimezone = Object.assign({}, config.scheduleConfig, { timezone: config.scheduleTimezone || 'local' });
            controller.setSchedule(scheduleWithTimezone);
            node.log('Loaded default schedule from UI config');
        }
        if (controller.schedule) {
            controller.syncSchedule();
        }

        // ---------- MQTT (как в оригинале) ----------
        var mqttClient = null;
        var uniqueId = config.mqttUniqueId || 'analog_thermostat_' + node.id;
        var baseTopic = config.mqttBaseTopic || 'homeassistant';

        if (config.mqttBroker) {
            mqttClient = RED.nodes.getNode(config.mqttBroker);
            if (mqttClient) {
                node.log('MQTT broker connected: ' + config.mqttBroker);
                // Подписки на команды (оригинальный синтаксис)
                var commandTopics = [
                    `climate/${uniqueId}/set_temp`,
                    `climate/${uniqueId}/set_mode`,
                    `climate/${uniqueId}/set_operating_mode`,
                    `climate/${uniqueId}/set_away`,
                    `climate/${uniqueId}/set_boost`
                ];
                commandTopics.forEach(function(topic) {
                    mqttClient.subscribe(topic, function(err) {
                        if (err) node.warn('Failed to subscribe to ' + topic + ': ' + err);
                        else node.log('Subscribed to ' + topic);
                    });
                });

                // Обработчик сообщений
                mqttClient.on('message', function(topic, payload) {
                    try {
                        var msg = payload.toString();
                        var stateChanged = false;
                        if (topic === `climate/${uniqueId}/set_temp`) {
                            var temp = parseFloat(msg);
                            if (!isNaN(temp)) {
                                controller.setSetpoint(temp);
                                node.log('MQTT set temp: ' + temp);
                                stateChanged = true;
                            }
                        } else if (topic === `climate/${uniqueId}/set_mode`) {
                            var mode = String(msg).toLowerCase();
                            var modeMap = { 'heating': 'heat', 'cooling': 'cool', 'auto': 'heat_cool', 'off': 'off' };
                            var normalized = modeMap[mode] || mode;
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
                            var opMode = String(msg).toLowerCase();
                            if (['manual', 'schedule', 'off'].includes(opMode)) {
                                controller.setOperatingMode(opMode);
                                node.log('MQTT set operating mode: ' + opMode);
                                stateChanged = true;
                            }
                        } else if (topic === `climate/${uniqueId}/set_away`) {
                            var val = msg.toLowerCase();
                            if (val === 'true' || val === 'on') {
                                controller.setAwayMode(true);
                                node.log('MQTT away enabled');
                                stateChanged = true;
                            } else if (val === 'false' || val === 'off') {
                                controller.setAwayMode(false);
                                node.log('MQTT away disabled');
                                stateChanged = true;
                            } else {
                                var temp = parseFloat(val);
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
                                    var boost = JSON.parse(msg);
                                    if (boost.temp && boost.duration) {
                                        controller.setBoost(boost);
                                        node.log('MQTT boost: ' + boost.temp + '°C for ' + boost.duration + 'min');
                                        stateChanged = true;
                                    }
                                } catch (e) {
                                    var temp = parseFloat(msg);
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

                // Публикация состояния (оригинал)
                function publishMqttState() {
                    if (!mqttClient) return;
                    try {
                        var state = controller.getState();
                        var result = controller.getStatus();
                        var currentTemp = state.currentTemp;
                        var targetTemp = state.targetTemp;
                        var mode = state.mode;
                        var operatingMode = state.operatingMode;
                        var away = state.awayMode;
                        var boost = state.boostActive;
                        var pid = result.debug.pid || {};

                        // Вычисляем процент только для публикации в отдельном топике и для выхода
                        var percent = mapTemperatureToPercent(
                            result.output,
                            controllerConfig.minTemp,
                            controllerConfig.maxTemp,
                            analogConfig.outputMapping
                        );
                        var finalPercent = analogConfig.roundToInteger ? Math.round(percent) : percent;

                        // Основные топики (как в оригинале)
                        if (currentTemp !== null && currentTemp !== undefined) {
                            mqttClient.publish(`climate/${uniqueId}/current_temp`, String(currentTemp), { retain: true });
                        }
                        if (targetTemp !== null && targetTemp !== undefined) {
                            mqttClient.publish(`climate/${uniqueId}/target_temp`, String(targetTemp), { retain: true });
                        }
                        mqttClient.publish(`climate/${uniqueId}/mode`, (operatingMode === 'off') ? 'off' : mode, { retain: true });
                        mqttClient.publish(`climate/${uniqueId}/operating_mode`, operatingMode, { retain: true });
                        mqttClient.publish(`climate/${uniqueId}/away`, away ? 'ON' : 'OFF', { retain: true });
                        mqttClient.publish(`climate/${uniqueId}/boost`, boost ? 'ON' : 'OFF', { retain: true });
                        mqttClient.publish(`climate/${uniqueId}/analog_output`, String(finalPercent), { retain: true });

                        // Полный state (как в оригинале, добавляем только analog_output)
                        var fullState = {
                            current_temperature: currentTemp,
                            target_temperature: targetTemp,
                            mode: (operatingMode === 'off') ? 'off' : mode,
                            operating_mode: operatingMode,
                            away: away,
                            boost: boost,
                            pid: pid,
                            error: result.debug.error,
                            trend: result.debug.trend,
                            state: result.debug.state,
                            active_mode: result.debug.activeMode || 'idle',
                            analog_output: finalPercent
                        };
                        mqttClient.publish(`climate/${uniqueId}/state`, JSON.stringify(fullState), { retain: true });
                    } catch (err) {
                        node.error('publishMqttState error: ' + err.message);
                    }
                }

                node.publishMqttState = publishMqttState;

                // Отправка Discovery (оригинал + analog_output)
                if (config.mqttDiscovery !== false) {
                    var device = {
                        identifiers: [uniqueId],
                        name: config.mqttDeviceName || 'Analog Thermostat',
                        manufacturer: config.mqttManufacturer || 'Node-RED',
                        model: config.mqttModel || 'Analog Thermostat',
                        sw_version: '1.0.0'
                    };
                    var climateConfig = {
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
                    mqttClient.publish(`${baseTopic}/climate/${uniqueId}/config`, JSON.stringify(climateConfig), { retain: true });
                    node.log('MQTT Discovery published');

                    // Дополнительный сенсор для analog_output (если нужен)
                    var sensorConfig = {
                        name: config.mqttDeviceName + ' Output',
                        unique_id: uniqueId + '_output',
                        device: device,
                        state_topic: `climate/${uniqueId}/analog_output`,
                        unit_of_measurement: '%',
                        icon: 'mdi:percent'
                    };
                    mqttClient.publish(`${baseTopic}/sensor/${uniqueId}_output/config`, JSON.stringify(sensorConfig), { retain: true });
                }

                node.on('close', function(removed, done) {
                    if (mqttClient) {
                        commandTopics.forEach(function(t) {
                            mqttClient.unsubscribe(t, function(err) {});
                        });
                        if (config.mqttDiscovery !== false) {
                            mqttClient.publish(`${baseTopic}/climate/${uniqueId}/config`, '', { retain: true });
                            mqttClient.publish(`${baseTopic}/sensor/${uniqueId}_output/config`, '', { retain: true });
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

        // ---------- Вспомогательная функция для пересчёта температуры в проценты ----------
        function mapTemperatureToPercent(temp, minTemp, maxTemp, mapping) {
            if (maxTemp === minTemp) return 50;
            var percent = ((temp - minTemp) / (maxTemp - minTemp)) * 100;
            percent = Math.max(0, Math.min(100, percent));
            if (mapping === 'inverse') {
                percent = 100 - percent;
            }
            return percent;
        }

        // ---------- Обработчик входных сообщений (оригинал, но msg1.payload заменён на процент) ----------
        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            try {
                var stateChanged = false;

                // Обработка команд из msg (оригинал)
                if (msg.setpoint !== undefined) {
                    var temp = parseFloat(msg.setpoint);
                    if (!isNaN(temp)) {
                        controller.setSetpoint(temp);
                        node.log('Setpoint changed via msg: ' + temp);
                        stateChanged = true;
                    }
                }
                if (msg.mode !== undefined) {
                    var mode = String(msg.mode).toLowerCase();
                    var normMode = modeMap[mode] || mode;
                    if (['heat', 'cool', 'heat_cool'].includes(normMode)) {
                        controller.setMode(normMode);
                        node.log('Mode changed via msg: ' + normMode);
                        stateChanged = true;
                    }
                }
                if (msg.operatingMode !== undefined) {
                    var opMode = String(msg.operatingMode).toLowerCase();
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

                var currentTemp = parseFloat(msg.payload);
                if (isNaN(currentTemp)) {
                    if (done) done();
                    return;
                }

                var result = controller.update(currentTemp);
                if (controller.hasParametersChanged()) {
                    saveStateToFile(node.id, controller.getState());
                    node.log('PID parameters updated (Kp=' + result.debug.pid.Kp +
                        ', Ki=' + result.debug.pid.Ki + ', Kd=' + result.debug.pid.Kd + ')');
                }

                if (node.publishMqttState) node.publishMqttState();

                // Вычисляем процент для выхода
                var percent = mapTemperatureToPercent(
                    result.output,
                    controllerConfig.minTemp,
                    controllerConfig.maxTemp,
                    analogConfig.outputMapping
                );
                var finalPercent = analogConfig.roundToInteger ? Math.round(percent) : percent;

                // Определяем активность
                var isActive = (controller.operatingMode !== 'off') && (Math.abs(result.debug.error) > controllerConfig.hysteresis);

                // Формируем выходные сообщения: на первом выходе процент, остальные как в оригинале
                var msg1 = { payload: finalPercent, topic: msg.topic || 'thermostat/analog' };
                var msg2 = { payload: result.debug, topic: msg.topic ? msg.topic + '/debug' : 'thermostat/debug' };
                var msg3 = { payload: isActive, topic: msg.topic ? msg.topic + '/active' : 'thermostat/active' };

                send([msg1, msg2, msg3]);

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

    RED.nodes.registerType('analog-thermostat', SmartThermostatNode);
};
