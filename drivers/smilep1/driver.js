/* eslint-disable import/no-extraneous-dependencies */
/* eslint-disable prefer-destructuring */
/*
Copyright 2016 - 2019, Robin de Gruijter (gruijter@hotmail.com)

This file is part of com.plugwise.smile.

com.plugwise.smile is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.plugwise.smile is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.plugwise.smile.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const Homey = require('homey');
const SmileP1 = require('smilep1');
const Ledring = require('../../ledring.js');

class SmileP1Driver extends Homey.Driver {

	onInit() {
		this.log('entering SmileP1 driver');
		this.Smile = SmileP1;
		this.ledring = new Ledring('smile_power');
	}

	onPair(socket) {
		socket.on('validate', async (data, callback) => {
			try {
				this.log('save button pressed in frontend');
				const host = data.smileIp.split(':')[0];
				const port = Number(data.smileIp.split(':')[1]) || 80;
				const options = {
					id: data.smileId,
					host,
					port,
				};
				const smile = new this.Smile(options);
				await smile.getMeterReadings()
					.catch((error) => {
						callback(error);
					});
				const device = {
					name: `Smile_${data.smileId}`,
					data: { id: data.smileId },
					settings: {
						smileIp: host,
						port,
						smileId: data.smileId,
						ledring_usage_limit: 3000,
						ledring_production_limit: 3000,
					},
					capabilities: [
						'measure_power',
						'meter_power',
						// 'measure_gas',
						// 'meter_gas',
						// 'meter_offPeak',
						// 'meter_power.peak',
						// 'meter_power.offPeak',
						// 'meter_power.producedPeak',
						// 'meter_power.producedOffPeak',
					],
				};
				if (data.includeOffPeak) {
					device.capabilities.push('meter_offPeak');
					device.capabilities.push('meter_power.peak');
					device.capabilities.push('meter_power.offPeak');
				}
				if (data.includeProduction) {
					device.capabilities.push('meter_power.producedPeak');
				}
				if (data.includeProduction && data.includeOffPeak) {
					device.capabilities.push('meter_power.producedOffPeak');
				}
				if (data.includeGas) {
					device.capabilities.push('measure_gas');
					device.capabilities.push('meter_gas');
				}
				callback(null, JSON.stringify(device)); // report success to frontend
			}	catch (error) {
				this.error('Pair error', error);
				if (error.code === 'EHOSTUNREACH') {
					callback(Error('Incorrect IP address'));
				}
				callback(error);
			}
		});
	}

	handleNewReadings(readings) {	// call with device as this
		// this.log(`handling new readings for ${this.getName()}`);
		// gas readings from device
		const meterGas = readings.gas; // gas_cumulative_meter
		const meterGasTm = readings.gtm; // gas_meter_timestamp
		let measureGas = this.meters.lastMeasureGas;
		// constructed gas readings
		const meterGasChanged = (this.meters.lastMeterGas !== meterGas) && (this.meters.lastMeterGasTm !== 0);
		const meterGasTmChanged = (meterGasTm !== this.meters.lastMeterGasTm) && (this.meters.lastMeterGasTm !== 0);
		if (meterGasChanged || meterGasTmChanged) {
			const passedHours = (meterGasTm - this.meters.lastMeterGasTm) / 3600000;
			if (passedHours > 0) {
				measureGas = Math.round((meterGas - this.meters.lastMeterGas) / passedHours) / 1000; // gas_interval_meter
			}
		}
		// electricity readings from device
		const meterPowerOffpeakProduced = readings.n1;
		const meterPowerPeakProduced = readings.n2;
		const meterPowerOffpeak = readings.p1;
		const meterPowerPeak = readings.p2;
		const meterPower = readings.net;
		let measurePower = readings.pwr;
		let measurePowerAvg = this.meters.lastMeasurePowerAvg;
		const meterPowerTm = readings.tm;
		// constructed electricity readings
		let offPeak = this.meters.lastOffpeak;
		if ((meterPower - this.meters.lastMeterPower) !== 0) {
			offPeak = ((meterPowerOffpeakProduced - this.meters.lastMeterPowerOffpeakProduced) > 0
			|| (meterPowerOffpeak - this.meters.lastMeterPowerOffpeak) > 0);
		}
		// measurePowerAvg 2 minutes average based on cumulative meters
		if (this.meters.lastMeterPowerIntervalTm === null) {	// first reading after init
			this.meters.lastMeterPowerInterval = meterPower;
			this.meters.lastMeterPowerIntervalTm = meterPowerTm;
		}
		if ((meterPowerTm - this.meters.lastMeterPowerIntervalTm) >= 120) {
			measurePowerAvg = Math.round((3600000 / 120) * (meterPower - this.meters.lastMeterPowerInterval));
			this.meters.lastMeterPowerInterval = meterPower;
			this.meters.lastMeterPowerIntervalTm = meterPowerTm;
		}
		// correct measurePower with average measurePower_produced in case point_meter_produced is always zero
		if (measurePower === 0 && measurePowerAvg < 0) {
			measurePower = measurePowerAvg;
		}
		const measurePowerDelta = (measurePower - this.meters.lastMeasurePower);
		// trigger the custom trigger flowcards
		if (offPeak !== this.meters.lastOffpeak) {
			const tokens = { tariff: offPeak };
			this.tariffChangedTrigger
				.trigger(this, tokens)
				.catch(this.error);
			// .then(this.log('Tariff change flow card triggered'));
		}
		if (measurePower !== this.meters.lastMeasurePower) {
			const tokens = {
				power: measurePower,
				power_delta: measurePowerDelta,
			};
			this.powerChangedTrigger
				.trigger(this, tokens)
				.catch(this.error);
			// .then(this.error('Power change flow card triggered'));
			// update the ledring screensavers
			this._ledring.change(this.getSettings(), measurePower);
		}
		// store the new readings in memory
		this.meters.lastMeasureGas = measureGas; // || this.meters.lastMeasureGas;
		this.meters.lastMeterGas = meterGas; // || this.meters.lastMeterGas;
		this.meters.lastMeterGasTm = meterGasTm || this.meters.lastMeterGasTm;
		this.meters.lastMeasurePower = measurePower; // || this.meters.lastMeasurePower;
		this.meters.lastMeasurePowerAvg = measurePowerAvg; // || this.meters.lastMeasurePowerAvg;
		this.meters.lastMeterPower = meterPower; // || this.meters.lastMeterPower;
		this.meters.lastMeterPowerPeak = meterPowerPeak; // || this.meters.lastMeterPowerPeak;
		this.meters.lastMeterPowerOffpeak = meterPowerOffpeak; // || this.meters.lastMeterPowerOffpeak;
		this.meters.lastMeterPowerPeakProduced = meterPowerPeakProduced; // || this.meters.lastMeterPowerPeakProduced;
		this.meters.lastMeterPowerOffpeakProduced = meterPowerOffpeakProduced; // || this.meters.lastMeterPowerOffpeakProduced;
		this.meters.lastMeterPowerTm = meterPowerTm || this.meters.lastMeterPowerTm;
		this.meters.lastOffpeak = offPeak;
		// update the device state
		// this.log(this.meters);
		this.updateDeviceState();
	}

}

module.exports = SmileP1Driver;
