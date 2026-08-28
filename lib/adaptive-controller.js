/**
 * Adaptive PID Controller with learning capabilities for thermostat applications
 */
class AdaptiveController {
    /**
     * @param {Object} config - Configuration parameters
     * @param {number} config.minTemp - Minimum temperature setpoint
     * @param {number} config.maxTemp - Maximum temperature setpoint
     * @param {number} config.targetTemp - Default target temperature
     * @param {number} config.hysteresis - Hysteresis value
     * @param {number} config.sampleInterval - Sample interval in milliseconds
     * @param {boolean} config.learningEnabled - Enable learning mode
     * @param {number} config.maxOutputChange - Maximum output change per cycle
     * @param {number} config.precision - Temperature precision
     * @param {string} config.mode - Operating mode (heat/cool/heat_cool)
     * @param {string} config.operatingMode - Operating mode (manual/schedule/off)
     * @param {number} config.awayTemp - Away temperature setpoint
     */
    constructor(config) {
        this.config = config;
        this.currentTemp = null;
        this.targetTemp = config.targetTemp;
        this.mode = config.mode; // 'heat', 'cool', 'heat_cool'
        this.operatingMode = config.operatingMode || 'manual';
        this.awayMode = false;
        this.awayTemp = config.awayTemp || 16;
        this.boostActive = false;
        this.boostEndTime = null;
        this.boostTemp = null;
        this.schedule = null;

        // PID parameters
        this.Kp = 1.0;
        this.Ki = 0.1;
        this.Kd = 0.05;
        this.previousError = 0;
        this.integral = 0;
        this.lastUpdate = Date.now();

        // Learning
        this.learningEnabled = config.learningEnabled !== false;
        this.learningSamples = [];
        this.maxSamples = 100;
        this.learningRate = 0.1;
        this.parametersChanged = false;
        this.learningState = 'idle'; // 'idle', 'learning', 'converged'

        // Performance metrics
        this.metrics = {
            overshoot: 0,
            settlingTime: 0,
            errorSum: 0,
            samples: 0
        };

        // State tracking
        this.lastOutput = 0;
        this.maxOutputChange = config.maxOutputChange || 0.5;
        this.precision = config.precision || 0.5;
        this.hysteresis = config.hysteresis || 0.2;

        // Initial state
        this.state = 'idle';
        this.startTime = Date.now();
        this.lastSampleTime = Date.now();
        this.sampleInterval = config.sampleInterval || 60000;
    }

    /**
     * Update controller with new temperature reading
     * @param {number} temperature - Current temperature reading
     * @returns {Object} Controller status
     */
    update(temperature) {
        this.currentTemp = temperature;
        const now = Date.now();

        // Check if enough time has passed since last update
        if (now - this.lastSampleTime < this.sampleInterval) {
            // Return current status without update
            return this.getStatus();
        }
        this.lastSampleTime = now;

        // Check boost timer
        if (this.boostActive && this.boostEndTime && now > this.boostEndTime) {
            this.boostActive = false;
            this.boostEndTime = null;
            this.targetTemp = this.config.targetTemp;
        }

        // Check schedule
        if (this.operatingMode === 'schedule' && this.schedule) {
            this.syncSchedule();
        }

        // Calculate error
        let error;
        if (this.mode === 'heat') {
            error = this.targetTemp - temperature;
        } else if (this.mode === 'cool') {
            error = temperature - this.targetTemp;
        } else {
            // heat_cool mode - determine if we need heating or cooling
            const tempDiff = temperature - this.targetTemp;
            if (Math.abs(tempDiff) < this.precision) {
                error = 0;
            } else if (tempDiff < 0) {
                error = Math.abs(tempDiff); // Need heating
            } else {
                error = -tempDiff; // Need cooling
            }
        }

        // Determine active mode for status display
        let activeMode = this.mode;
        if (this.mode === 'heat_cool') {
            if (temperature < this.targetTemp - this.precision) {
                activeMode = 'heat';
            } else if (temperature > this.targetTemp + this.precision) {
                activeMode = 'cool';
            } else {
                activeMode = 'idle';
            }
        }

        // Calculate PID output
        let output = this.calculatePID(error, now);

        // Apply output limits and rate limiting
        output = this.limitOutput(output);

        // Update learning
        if (this.learningEnabled) {
            this.learn(error, temperature, output);
        }

        // Update metrics
        this.updateMetrics(error, temperature, output, activeMode);

        // Update state
        this.previousError = error;
        this.lastOutput = output;

        return this.getStatus();
    }

    /**
     * Calculate PID output
     * @param {number} error - Current error
     * @param {number} timestamp - Current timestamp
     * @returns {number} PID output
     */
    calculatePID(error, timestamp) {
        const dt = (timestamp - this.lastUpdate) / 1000; // seconds
        if (dt === 0) return this.lastOutput;

        // Proportional term
        const P = this.Kp * error;

        // Integral term with anti-windup
        this.integral += error * dt;
        // Clamp integral to prevent windup
        const maxIntegral = 10;
        this.integral = Math.max(-maxIntegral, Math.min(maxIntegral, this.integral));
        const I = this.Ki * this.integral;

        // Derivative term
        const D = this.Kd * (error - this.previousError) / dt;

        // Calculate output
        let output = P + I + D;

        // Apply dead zone for small errors
        if (Math.abs(error) < this.hysteresis) {
            output = 0;
        }

        this.lastUpdate = timestamp;
        return output;
    }

    /**
     * Limit output and apply rate limiting
     * @param {number} output - Raw PID output
     * @returns {number} Limited output
     */
    limitOutput(output) {
        // Apply rate limiting
        const maxChange = this.maxOutputChange;
        let limitedOutput = output;

        // Clamp output to reasonable range (temperature setpoint range)
        const tempRange = this.config.maxTemp - this.config.minTemp;
        const minOutput = this.config.minTemp - 1;
        const maxOutput = this.config.maxTemp + 1;

        // Apply rate limiting
        if (Math.abs(output - this.lastOutput) > maxChange) {
            limitedOutput = this.lastOutput + Math.sign(output - this.lastOutput) * maxChange;
        }

        // Clamp to range
        limitedOutput = Math.max(minOutput, Math.min(maxOutput, limitedOutput));

        // Round to precision
        limitedOutput = Math.round(limitedOutput / this.precision) * this.precision;

        return limitedOutput;
    }

    /**
     * Learn from system response
     * @param {number} error - Current error
     * @param {number} temperature - Current temperature
     * @param {number} output - Current output
     */
    learn(error, temperature, output) {
        // Store sample for learning
        this.learningSamples.push({
            timestamp: Date.now(),
            error: error,
            temperature: temperature,
            output: output
        });

        // Keep only recent samples
        if (this.learningSamples.length > this.maxSamples) {
            this.learningSamples.shift();
        }

        // Only learn if we have enough samples
        if (this.learningSamples.length < 10) {
            this.learningState = 'learning';
            return;
        }

        // Check if system has settled
        const recentErrors = this.learningSamples.slice(-10).map(s => Math.abs(s.error));
        const avgError = recentErrors.reduce((a, b) => a + b, 0) / recentErrors.length;

        if (avgError < 0.5) {
            // System is stable, adjust PID parameters
            this.learningState = 'converged';
            this.adjustPIDParameters();
        } else {
            this.learningState = 'learning';
        }
    }

    /**
     * Adjust PID parameters based on learning
     */
    adjustPIDParameters() {
        if (this.learningSamples.length < 20) return;

        // Extract system response data
        const samples = this.learningSamples;
        const errors = samples.map(s => s.error);
        const outputs = samples.map(s => s.output);

        // Simple heuristic adjustment
        // For a well-tuned system, we want:
        // - Fast response (small error)
        // - Minimal overshoot

        const avgError = errors.reduce((a, b) => a + b, 0) / errors.length;
        const maxError = Math.max(...errors.map(Math.abs));
        const errorRange = Math.max(...errors) - Math.min(...errors);

        // Adjust Kp based on error magnitude
        if (avgError > 1.0) {
            this.Kp = Math.min(this.Kp * 1.1, 5.0); // Increase proportional gain
        } else if (avgError < 0.3 && maxError < 0.5) {
            this.Kp = Math.max(this.Kp * 0.95, 0.1); // Decrease proportional gain slightly
        }

        // Adjust Ki based on steady-state error
        const steadyStateError = errors[errors.length - 1];
        if (Math.abs(steadyStateError) > 0.2) {
            this.Ki = Math.min(this.Ki * 1.1, 1.0);
        } else if (Math.abs(steadyStateError) < 0.1) {
            this.Ki = Math.max(this.Ki * 0.95, 0.01);
        }

        // Adjust Kd based on overshoot
        if (maxError > 2.0) {
            this.Kd = Math.min(this.Kd * 1.1, 1.0);
        } else if (maxError < 0.5) {
            this.Kd = Math.max(this.Kd * 0.95, 0.01);
        }

        // Mark parameters as changed
        this.parametersChanged = true;
    }

    /**
     * Update performance metrics
     */
    updateMetrics(error, temperature, output, activeMode) {
        this.metrics.samples++;
        this.metrics.errorSum += Math.abs(error);

        // Track overshoot
        if (activeMode !== 'idle') {
            const overshoot = Math.abs(error) - this.hysteresis;
            if (overshoot > 0 && overshoot > this.metrics.overshoot) {
                this.metrics.overshoot = overshoot;
            }
        }

        // Track settling time
        if (this.metrics.samples > 10 && Math.abs(error) < 0.5) {
            if (this.metrics.settlingTime === 0) {
                this.metrics.settlingTime = Date.now() - this.startTime;
            }
        }
    }

    /**
     * Get current controller status
     * @returns {Object} Controller status object
     */
    getStatus() {
        const error = this.getCurrentError();

        return {
            output: this.lastOutput,
            debug: {
                currentTemp: this.currentTemp,
                targetTemp: this.targetTemp,
                error: error,
                Kp: this.Kp,
                Ki: this.Ki,
                Kd: this.Kd,
                integral: this.integral,
                previousError: this.previousError,
                state: this.learningState,
                operatingMode: this.operatingMode,
                mode: this.mode,
                activeMode: this.getActiveMode(),
                awayMode: this.awayMode,
                boostActive: this.boostActive,
                boostRemaining: this.boostActive && this.boostEndTime ? 
                    Math.round((this.boostEndTime - Date.now()) / 60000) : 0,
                trend: this.getTrend(),
                metrics: this.metrics,
                learningSamples: this.learningSamples.length
            }
        };
    }

    /**
     * Get current active mode for display
     * @returns {string} Active mode
     */
    getActiveMode() {
        if (this.currentTemp === null || this.targetTemp === null) return 'idle';

        const tempDiff = this.currentTemp - this.targetTemp;

        if (this.mode === 'heat') {
            return tempDiff < 0 ? 'heat' : 'idle';
        } else if (this.mode === 'cool') {
            return tempDiff > 0 ? 'cool' : 'idle';
        } else { // heat_cool
            if (tempDiff < -this.precision) return 'heat';
            if (tempDiff > this.precision) return 'cool';
            return 'idle';
        }
    }

    /**
     * Get current error
     * @returns {number} Current error
     */
    getCurrentError() {
        if (this.currentTemp === null || this.targetTemp === null) return 0;

        if (this.mode === 'heat') {
            return this.targetTemp - this.currentTemp;
        } else if (this.mode === 'cool') {
            return this.currentTemp - this.targetTemp;
        } else {
            // heat_cool - return absolute error with sign indicating heating/cooling
            const diff = this.currentTemp - this.targetTemp;
            if (Math.abs(diff) < this.hysteresis) return 0;
            return -diff; // Positive means need heating, negative means need cooling
        }
    }

    /**
     * Get temperature trend
     * @returns {string} Trend ('warming', 'cooling', 'stable')
     */
    getTrend() {
        if (this.learningSamples.length < 3) return 'stable';

        const recent = this.learningSamples.slice(-5);
        const temps = recent.map(s => s.temperature);
        const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
        const last = temps[temps.length - 1];

        if (last > avg + 0.1) return 'warming';
        if (last < avg - 0.1) return 'cooling';
        return 'stable';
    }

    /**
     * Set target temperature setpoint
     * @param {number} temperature - Target temperature
     */
    setSetpoint(temperature) {
        this.targetTemp = Math.max(this.config.minTemp, Math.min(this.config.maxTemp, temperature));
        // If boost is active, deactivate it
        if (this.boostActive) {
            this.boostActive = false;
            this.boostEndTime = null;
        }
    }

    /**
     * Set operating mode
     * @param {string} mode - 'manual', 'schedule', or 'off'
     */
    setOperatingMode(mode) {
        if (['manual', 'schedule', 'off'].includes(mode)) {
            this.operatingMode = mode;
            if (mode === 'off') {
                this.lastOutput = 0;
            }
            if (mode === 'schedule' && this.schedule) {
                this.syncSchedule();
            }
        }
    }

    /**
     * Set controller mode
     * @param {string} mode - 'heat', 'cool', or 'heat_cool'
     */
    setMode(mode) {
        if (['heat', 'cool', 'heat_cool'].includes(mode)) {
            this.mode = mode;
        }
    }

    /**
     * Set away mode
     * @param {boolean|number} mode - true (use default away temp), false (disable), or temperature value
     */
    setAwayMode(mode) {
        if (mode === false) {
            this.awayMode = false;
            // Restore target temperature
            if (this.awayTemp && this.targetTemp === this.awayTemp) {
                this.targetTemp = this.config.targetTemp;
            }
            return;
        }

        this.awayMode = true;
        if (typeof mode === 'number' && !isNaN(mode)) {
            this.awayTemp = mode;
        }
        // Set target to away temperature
        this.targetTemp = this.awayTemp;
    }

    /**
     * Set boost mode
     * @param {Object|boolean} boost - {temp: number, duration: number} or false
     */
    setBoost(boost) {
        if (boost === false) {
            this.boostActive = false;
            this.boostEndTime = null;
            this.targetTemp = this.config.targetTemp;
            return;
        }

        if (boost && typeof boost === 'object') {
            this.boostActive = true;
            this.boostTemp = boost.temp;
            this.boostEndTime = Date.now() + (boost.duration || 60) * 60000;
            this.targetTemp = boost.temp;
        }
    }

    /**
     * Set schedule
     * @param {Object} schedule - Schedule object
     */
    setSchedule(schedule) {
        this.schedule = schedule;
        if (this.operatingMode === 'schedule') {
            this.syncSchedule();
        }
    }

    /**
     * Sync with schedule
     */
    syncSchedule() {
        if (!this.schedule || this.operatingMode !== 'schedule') return;

        const now = new Date();
        const timezone = this.schedule.timezone || 'local';
        const day = now.toLocaleString('en-US', { weekday: 'long', timeZone: timezone }).toLowerCase();

        // Get day schedule or default
        let daySchedule = this.schedule[day];
        if (!daySchedule) {
            daySchedule = this.schedule.default || [];
        }

        // If schedule is empty, use default
        if (!daySchedule || daySchedule.length === 0) {
            return;
        }

        // Find current time slot
        const currentTime = now.toLocaleTimeString('en-US', { hour12: false, timeZone: timezone });
        const currentMinutes = this.timeToMinutes(currentTime);

        // Sort schedule by time
        daySchedule.sort((a, b) => this.timeToMinutes(a.time) - this.timeToMinutes(b.time));

        let targetTemp = null;
        for (let i = daySchedule.length - 1; i >= 0; i--) {
            const slot = daySchedule[i];
            const slotMinutes = this.timeToMinutes(slot.time);
            if (currentMinutes >= slotMinutes) {
                targetTemp = slot.temp;
                break;
            }
        }

        // If no match, use last slot
        if (targetTemp === null && daySchedule.length > 0) {
            targetTemp = daySchedule[daySchedule.length - 1].temp;
        }

        if (targetTemp !== null) {
            // Don't override boost or away
            if (!this.boostActive && !this.awayMode) {
                this.targetTemp = targetTemp;
            }
        }
    }

    /**
     * Convert time string to minutes
     * @param {string} time - Time string (HH:MM)
     * @returns {number} Minutes since midnight
     */
    timeToMinutes(time) {
        const parts = time.split(':');
        return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    }

    /**
     * Get current state for persistence
     * @returns {Object} State object
     */
    getState() {
        return {
            Kp: this.Kp,
            Ki: this.Ki,
            Kd: this.Kd,
            integral: this.integral,
            previousError: this.previousError,
            targetTemp: this.targetTemp,
            mode: this.mode,
            operatingMode: this.operatingMode,
            awayMode: this.awayMode,
            awayTemp: this.awayTemp,
            learningState: this.learningState,
            learningSamples: this.learningSamples,
            metrics: this.metrics
        };
    }

    /**
     * Set state from persistence
     * @param {Object} state - State object
     */
    setState(state) {
        this.Kp = state.Kp || 1.0;
        this.Ki = state.Ki || 0.1;
        this.Kd = state.Kd || 0.05;
        this.integral = state.integral || 0;
        this.previousError = state.previousError || 0;
        this.targetTemp = state.targetTemp || this.config.targetTemp;
        this.mode = state.mode || this.config.mode;
        this.operatingMode = state.operatingMode || 'manual';
        this.awayMode = state.awayMode || false;
        this.awayTemp = state.awayTemp || this.config.awayTemp;
        this.learningState = state.learningState || 'idle';
        this.learningSamples = state.learningSamples || [];
        this.metrics = state.metrics || { overshoot: 0, settlingTime: 0, errorSum: 0, samples: 0 };
    }

    /**
     * Check if PID parameters have changed
     * @returns {boolean} True if parameters changed
     */
    hasParametersChanged() {
        if (this.parametersChanged) {
            this.parametersChanged = false;
            return true;
        }
        return false;
    }
}

module.exports = AdaptiveController;
