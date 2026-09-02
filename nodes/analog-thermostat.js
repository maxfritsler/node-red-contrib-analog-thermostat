const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

// ============================================================
//  ПРОСТОЙ PID-РЕГУЛЯТОР (без обучения)
// ============================================================
class PIDController {
    constructor(config) {
        this.config = config;
        // Коэффициенты (можно будет настраивать позже)
        this.Kp = 2.0;
        this.Ki = 0.5;
        this.Kd = 0.1;
        this.integral = 0;
        this.lastError = 0;
        this.lastOutput = null;
        this.currentTemp = null;
        this.targetTemp = config.targetTemp || 21;
        this.mode = config.mode || 'heat';         // heat, cool, heat_cool
        this.operatingMode = config.operatingMode || 'manual'; // manual, schedule, off
        this.awayMode = false;
        this.boostActive = false;
        this.boostEndTime = null;
        this.boostTemp = null;
        this.schedule = null;
        this.state = 'idle';
        this.activeMode = this.mode;
        this.trend = 'stable';
        this.error = 0;
        this.pid = { Kp: this.Kp, Ki: this.Ki, Kd: this.Kd };
    }

    // Установка уставки
    setSetpoint(temp) {
        this.targetTemp = Math.min(this.config.maxTemp, Math.max(this.config.minTemp, temp));
        if (this.boostActive) {
            this.boostActive = false;
            this.boostEndTime = null;
            this.boostTemp = null;
        }
    }

    setMode(mode) {
        if (['heat', 'cool', 'heat_cool'].includes(mode)) {
            this.mode = mode;
        }
    }

    setOperatingMode(mode) {
        if (['manual', 'schedule', 'off'].includes(mode)) {
            this.operatingMode = mode;
            if (mode === 'off') {
                this.state = 'idle';
                this.activeMode = this.mode;
            }
        }
    }

    setAwayMode(value) {
        if (typeof value === 'boolean') {
            this.awayMode = value;
        } else if (typeof value === 'number') {
            this.config.awayTemp = value;
            this.awayMode = true;
        } else {
            this.awayMode = !!value;
        }
    }

    setBoost(boost) {
        if (boost === false) {
            this.boostActive = false;
            this.boostEndTime = null;
            this.boostTemp = null;
            return;
        }
        if (boost && typeof boost === 'object' && boost.temp !== undefined && boost.duration !== undefined) {
            this.boostActive = true;
            this.boostTemp = Math.min(this.config.maxTemp, Math.max(this.config.minTemp, boost.temp));
            this.boostEndTime = Date.now() + boost.duration * 60000;
        }
    }

    setSchedule(schedule) {
        this.schedule = schedule;
    }

    syncSchedule() {
        // (заглушка, можно реализовать позже)
    }

    // Основной расчёт
    update(currentTemp) {
        this.currentTemp = currentTemp;
        const now = Date.now();

        // --- Проверка Boost ---
        if (this.boostActive && this.boostEndTime && now > this.boostEndTime) {
            this.boostActive = false;
            this.boostEndTime = null;
            this.boostTemp = null;
        }

        // --- Определение целевой температуры ---
        let target = this.targetTemp;
        if (this.awayMode) {
            target = this.config.awayTemp || 16;
        } else if (this.boostActive && this.boostTemp !== null) {
            target = this.boostTemp;
        } else if (this.operatingMode === 'schedule' && this.schedule) {
            // (здесь логика расписания, но пока оставим target без изменений)
        }

        // --- Если выключен ---
        if (this.operatingMode === 'off') {
            this.state = 'idle';
            this.trend = 'off';
            this.lastOutput = target;
            return {
                output: target,
                debug: {
                    currentTemp,
                    targetTemp: target,
                    error: 0,
                    activeMode: 'idle',
                    state: 'off',
                    trend: 'off',
                    operatingMode: this.operatingMode,
                    awayMode: this.awayMode,
                    boostActive: this.boostActive,
                    pid: { Kp: this.Kp, Ki: this.Ki, Kd: this.Kd }
                }
            };
        }

        // --- Определение режима (heat/cool) ---
        let error = target - currentTemp;
        if (this.mode === 'cool') {
            error = -error; // охлаждение: ошибка инвертируется
        } else if (this.mode === 'heat_cool') {
            // Автоматический выбор: если error > 0.5 -> heat, если error < -0.5 -> cool
            if (error > 0.5) {
                this.activeMode = 'heat';
            } else if (error < -0.5) {
                this.activeMode = 'cool';
            }
            // Если в зоне гистерезиса, активный режим остаётся прежним
        } else {
            this.activeMode = this.mode;
        }

        // Если активный режим heat, ошибка = target - currentTemp (стандартно)
        // Если cool, ошибка = currentTemp - target (уже инвертирована выше)
        // Для heat_cool мы уже определили активный режим, и ошибка уже соответствует.
        // Но для унификации: используем error как разность target - currentTemp,
        // а затем для heat оставляем как есть, для cool инвертируем.

        let finalError = error;
        if (this.activeMode === 'cool') {
            finalError = -error; // для cool PID должен реагировать на избыток температуры
        }

        // --- PID расчёт ---
        const dt = 1; // предполагаем фиксированный интервал ~1 сек (можно брать реальный, но упростим)
        const P = this.Kp * finalError;
        this.integral += finalError * dt;
        // Анти-виндап
        const maxIntegral = 100;
        if (this.integral > maxIntegral) this.integral = maxIntegral;
        if (this.integral < -maxIntegral) this.integral = -maxIntegral;
        const I = this.Ki * this.integral;
        const derivative = (finalError - this.lastError) / (dt || 0.001);
        const D = this.Kd * derivative;
        let correction = P + I + D;

        // --- Выход — температура уставки с коррекцией ---
        let output = target + correction;
        // Ограничиваем диапазоном minTemp..maxTemp
        output = Math.min(this.config.maxTemp, Math.max(this.config.minTemp, output));

        // Ограничение скорости изменения
        const maxChange = this.config.maxOutputChange || 0.5;
        if (this.lastOutput !== null) {
            if (output > this.lastOutput + maxChange) output = this.lastOutput + maxChange;
            if (output < this.lastOutput - maxChange) output = this.lastOutput - maxChange;
        }
        this.lastOutput = output;

        // --- Определение тренда ---
        const hysteresis = this.config.hysteresis || 0.2;
        if (finalError > hysteresis) {
            this.trend = 'warming';
        } else if (finalError < -hysteresis) {
            this.trend = 'cooling';
        } else {
            this.trend = 'stable';
        }

        this.state = 'idle'; // всегда idle, нет обучения
        this.lastError = finalError;
        this.error = finalError;

        // Сохраняем PID для отладки
        this.pid = { Kp: this.Kp, Ki: this.Ki, Kd: this.Kd };

        // Возвращаем результат
        return {
            output: output,
            debug: {
                currentTemp,
                targetTemp: target,
                error: finalError,
                activeMode: this.activeMode,
                state: this.state,
                trend: this.trend,
                operatingMode: this.operatingMode,
                awayMode: this.awayMode,
                boostActive: this.boostActive,
                boostRemaining: this.boostActive ? Math.round((this.boostEndTime - Date.now()) / 60000) : 0,
                pid: this.pid,
                integral: this.integral,
                lastError: this.lastError,
                Kp: this.Kp,
                Ki: this.Ki,
                Kd: this.Kd
            }
        };
    }

    // Получить текущее состояние (без обновления)
    getStatus() {
        if (this.currentTemp !== null) {
            return this.update(this.currentTemp);
        }
        return {
            output: this.targetTemp,
            debug: {
                currentTemp: this.currentTemp,
                targetTemp: this.targetTemp,
                error: 0,
                activeMode: this.activeMode,
                state: this.state,
                trend: this.trend,
                operatingMode: this.operatingMode,
                awayMode: this.awayMode,
                boostActive: this.boostActive,
                pid: { Kp: this.Kp, Ki: this.Ki, Kd: this.Kd }
            }
        };
    }

    // Сохранение/восстановление состояния (для файла)
    getState() {
        return {
            Kp: this.Kp,
            Ki: this.Ki,
            Kd: this.Kd,
            integral: this.integral,
            lastError: this.lastError,
            lastOutput: this.lastOutput,
            targetTemp: this.targetTemp,
            mode: this.mode,
            operatingMode: this.operatingMode,
            awayMode: this.awayMode,
            boostActive: this.boostActive,
            boostEndTime: this.boostEndTime,
            boostTemp: this.boostTemp,
            currentTemp: this.currentTemp,
            activeMode: this.activeMode,
            state: this.state,
            trend: this.trend,
            pid: this.pid
        };
    }

    setState(state) {
        if (state.Kp !== undefined) this.Kp = state.Kp;
        if (state.Ki !== undefined) this.Ki = state.Ki;
        if (state.Kd !== undefined) this.Kd = state.Kd;
        if (state.integral !== undefined) this.integral = state.integral;
        if (state.lastError !== undefined) this.lastError = state.lastError;
        if (state.lastOutput !== undefined) this.lastOutput = state.lastOutput;
        if (state.targetTemp !== undefined) this.targetTemp = state.targetTemp;
        if (state.mode !== undefined) this.mode = state.mode;
        if (state.operatingMode !== undefined) this.operatingMode = state.operatingMode;
        if (state.awayMode !== undefined) this.awayMode = state.awayMode;
        if (state.boostActive !== undefined) this.boostActive = state.boostActive;
        if (state.boostEndTime !== undefined) this.boostEndTime = state.boostEndTime;
        if (state.boostTemp !== undefined) this.boostTemp = state.boostTemp;
        if (state.currentTemp !== undefined) this.currentTemp = state.currentTemp;
        if (state.activeMode !== undefined) this.activeMode = state.activeMode;
        if (state.state !== undefined) this.state = state.state;
        if (state.trend !== undefined) this.trend = state.trend;
        if (state.pid) this.pid = state.pid;
    }

    hasParametersChanged() {
        return false; // ничего не меняется автоматически
    }
}

// ============================================================
//  NODE-RED УЗЕЛ
// ============================================================
module.exports = function(RED) {
    function AnalogThermostatNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.log('===== ANALOG THERMOSTAT VERSION 2.0.0 (NEW PID) =====');

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

        // --- Создаём PID-контроллер ---
        const controller = new PIDController(controllerConfig);

        // --- Состояние (для сохранения в файл) ---
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

        // --- Восстановление состояния ---
        let savedState = loadStateFromFile(node.id);
        if (savedState) {
            controller.setState(savedState);
            node.log('Restored controller state');
        }

        // --- Расписание ---
        if (config.scheduleEnabled && config.scheduleConfig && !controller.schedule) {
            const scheduleWithTimezone = { ...config.scheduleConfig, timezone: config.scheduleTimezone || 'local' };
            controller.setSchedule(scheduleWithTimezone);
            node.log('Loaded default schedule from UI config');
        }
        if (controller.schedule) {
            controller.syncSchedule();
        }

        // ============================================================
        //  MQTT
        // ============================================================
        let mqttClient = null;
        const uniqueId = config.mqttUniqueId || 'analog_thermostat_' + node.id;
        const baseTopic = config.mqttBaseTopic || 'homeassistant';

        let brokerUrl = config.mqttBrokerUrl || 'mqtt://localhost:1883';
        let mqttOptions = {};
        if (config.mqttBroker) {
            const brokerNode = RED.nodes.getNode(config.mqttBroker);
            if (brokerNode) {
                brokerUrl = brokerNode.brokerurl || brokerNode.url || brokerUrl;
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

        if (brokerUrl) {
            try {
                mqttClient = mqtt.connect(brokerUrl, mqttOptions);

                mqttClient.on('connect', () => {
                    node.log('MQTT connected to ' + brokerUrl);

                    // --- Discovery (климат + сенсор выхода) ---
                    if (config.mqttDiscovery !== false) {
                        const device = {
                            identifiers: [uniqueId],
                            name: config.mqttDeviceName || 'Analog Thermostat',
                            manufacturer: config.mqttManufacturer || 'Node-RED',
                            model: config.mqttModel || 'Analog Thermostat',
                            sw_version: '2.0.0'
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
                        mqttClient.publish(`${baseTopic}/climate/${uniqueId}/config`, JSON.stringify(climateConfig), { retain: true });
                        node.log('MQTT Discovery climate published');

                        // Сенсор выхода (0-100%)
                        const sensorConfig = {
                            name: config.mqttDeviceName + ' Output',
                            unique_id: uniqueId + '_output',
                            device: device,
                            state_topic: `climate/${uniqueId}/analog_output`,
                            unit_of_measurement: '%',
                            icon: 'mdi:percent'
                        };
                        mqttClient.publish(`${baseTopic}/sensor/${uniqueId}_output/config`, JSON.stringify(sensorConfig), { retain: true });
                        node.log('MQTT Discovery sensor published');
                    }

                    // --- Подписки на команды ---
                    const commandTopics = [
                        `climate/${uniqueId}/set_temp`,
                        `climate/${uniqueId}/set_mode`,
                        `climate/${uniqueId}/set_operating_mode`,
                        `climate/${uniqueId}/set_away`,
                        `climate/${uniqueId}/set_boost`
                    ];
                    commandTopics.forEach(t => {
                        mqttClient.subscribe(t, (err) => {
                            if (err) node.warn('Failed to subscribe to ' + t);
                            else node.log('Subscribed to ' + t);
                        });
                    });
                });

                // --- Обработка входящих MQTT сообщений ---
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

                // --- Функция публикации состояния ---
                function publishMqttState() {
                    if (!mqttClient || !mqttClient.connected) return;
                    try {
                        const state = controller.getState();
                        const result = controller.getStatus();
                        const currentTemp = state.currentTemp;
                        const targetTemp = state.targetTemp;
                        const mode = state.mode;
                        const operatingMode = state.operatingMode;

                        // --- Преобразование выхода в проценты ---
                        let percent = mapTemperatureToPercent(
                            result.output,
                            controllerConfig.minTemp,
                            controllerConfig.maxTemp,
                            analogConfig.outputMapping
                        );
                        // Защита от отрицательных процентов
                        percent = Math.max(0, Math.min(100, percent));
                        const finalPercent = analogConfig.roundToInteger ? Math.round(percent) : percent;
                        const isActive = (operatingMode !== 'off') && (Math.abs(result.debug.error) > controllerConfig.hysteresis);

                        // --- Основные топики (как в оригинале) ---
                        if (currentTemp !== null && currentTemp !== undefined) {
                            mqttClient.publish(`climate/${uniqueId}/current_temp`, String(currentTemp), { retain: true });
                        }
                        if (targetTemp !== null && targetTemp !== undefined) {
                            mqttClient.publish(`climate/${uniqueId}/target_temp`, String(targetTemp), { retain: true });
                        }
                        mqttClient.publish(`climate/${uniqueId}/mode`, (operatingMode === 'off') ? 'off' : mode, { retain: true });
                        mqttClient.publish(`climate/${uniqueId}/operating_mode`, operatingMode, { retain: true });
                        mqttClient.publish(`climate/${uniqueId}/away`, state.awayMode ? 'ON' : 'OFF', { retain: true });
                        mqttClient.publish(`climate/${uniqueId}/boost`, state.boostActive ? 'ON' : 'OFF', { retain: true });
                        mqttClient.publish(`climate/${uniqueId}/analog_output`, String(finalPercent), { retain: true });
                        mqttClient.publish(`climate/${uniqueId}/active`, isActive ? 'ON' : 'OFF', { retain: true });

                        // Отладочные топики
                        mqttClient.publish(`climate/${uniqueId}/error`, String(result.debug.error ?? 0), { retain: true });
                        mqttClient.publish(`climate/${uniqueId}/trend`, result.debug.trend || 'stable', { retain: true });
                        mqttClient.publish(`climate/${uniqueId}/state_info`, result.debug.state || 'idle', { retain: true });
                        mqttClient.publish(`climate/${uniqueId}/pid_kp`, String(result.debug.pid.Kp ?? 0), { retain: true });
                        mqttClient.publish(`climate/${uniqueId}/pid_ki`, String(result.debug.pid.Ki ?? 0), { retain: true });
                        mqttClient.publish(`climate/${uniqueId}/pid_kd`, String(result.debug.pid.Kd ?? 0), { retain: true });

                        // Полный debug
                        mqttClient.publish(`climate/${uniqueId}/debug`, JSON.stringify(result.debug), { retain: true });

                        // State JSON (как в оригинале)
                        const fullState = {
                            current_temperature: currentTemp,
                            target_temperature: targetTemp,
                            mode: (operatingMode === 'off') ? 'off' : mode,
                            operating_mode: operatingMode,
                            away: state.awayMode,
                            boost: state.boostActive,
                            pid: result.debug.pid,
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

                // --- Закрытие узла ---
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

        // ============================================================
        //  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
        // ============================================================
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

            let fill = 'grey';
            let shape = 'ring';
            let text = '';

            if (boostActive) {
                fill = 'yellow';
                shape = 'dot';
                text = `BOOST ${percent}%`;
            } else if (awayMode) {
                fill = 'grey';
                shape = 'ring';
                text = `AWAY ${percent}%`;
            } else if (operatingMode === 'off') {
                fill = 'grey';
                shape = 'ring';
                text = '⏹ OFF';
            } else if (Math.abs(error) < controllerConfig.hysteresis) {
                fill = 'green';
                shape = 'dot';
                text = `✅ ${percent}% (${result.debug.currentTemp}°C)`;
            } else if (activeMode === 'heat') {
                fill = 'red';
                shape = 'dot';
                text = `🔥 ${percent}% (${result.debug.currentTemp}°C → ${result.debug.targetTemp}°C)`;
            } else if (activeMode === 'cool') {
                fill = 'blue';
                shape = 'dot';
                text = `❄️ ${percent}% (${result.debug.currentTemp}°C → ${result.debug.targetTemp}°C)`;
            } else {
                fill = 'grey';
                shape = 'ring';
                text = `${percent}% (${result.debug.currentTemp}°C)`;
            }
            node.status({ fill, shape, text });
        }

        // ============================================================
        //  ОБРАБОТКА ВХОДНЫХ СООБЩЕНИЙ (msg)
        // ============================================================
        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            try {
                let stateChanged = false;

                // Обработка команд из msg (setpoint, mode, operatingMode, away, boost, schedule)
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

                // --- Основной расчёт ---
                const result = controller.update(currentTemp);
                saveStateToFile(node.id, controller.getState()); // сохраняем состояние после обновления

                // Публикация MQTT
                if (node.publishMqttState) node.publishMqttState();

                // Обновление статуса узла
                updateStatus(result);

                // --- Выходные сообщения ---
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

        node.on('close', function(removed, done) {
            saveStateToFile(node.id, controller.getState());
            node.log('Controller state saved (close)');
            if (done) done();
        });
    }

    RED.nodes.registerType('analog-thermostat', AnalogThermostatNode);
};
