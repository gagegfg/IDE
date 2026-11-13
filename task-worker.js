// --- UTILITY FUNCTIONS ---
function getLocalDateString(d) {
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(d);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// --- MAIN CALCULATION FUNCTION (O(N) Single-Pass Optimized) ---
function processDataChunk(dataChunk, dailyAggregationType) {
    // 1. De-duplicate Production Runs within the chunk
    const uniqueRuns = new Map();
    for (let i = 0; i < dataChunk.length; i++) {
        const row = dataChunk[i];
        if (row.IdProduccion) {
            const dateKey = row.dateStr || getLocalDateString(row.Fecha);
            const key = `${row.IdProduccion}-${dateKey}-${row.Turno}-${row.Descrip_Maquina}`;
            if (!uniqueRuns.has(key)) {
                uniqueRuns.set(key, row);
            }
        }
    }
    const uniqueRunData = Array.from(uniqueRuns.values());

    // 2. Calculate KPIs and Machine/Operator/Daily Aggregations from uniqueRunData
    let totalProduction = 0;
    let totalNetProductionMinutes = 0;
    const numberOfProductionRuns = uniqueRunData.length;

    const operatorStats = new Map();
    const machineProdAggregation = new Map();
    const machineSummaryMap = new Map();
    const dailyProdAggregation = new Map();
    const dailyTimeAggregation = {};

    for (let i = 0; i < uniqueRunData.length; i++) {
        const run = uniqueRunData[i];
        const cant = run.Cantidad || 0;
        const hsTrab = run.Hs_Trab || 0; // Minutos netos trabajados en el turno
        const dateStr = run.dateStr || getLocalDateString(run.Fecha);
        const machine = run.Descrip_Maquina;

        totalProduction += cant;
        totalNetProductionMinutes += hsTrab;

        // Operario stats
        if (run.Apellido) {
            let opEntry = operatorStats.get(run.Apellido);
            if (!opEntry) {
                opEntry = { totalProduction: 0, numberOfRuns: 0 };
                operatorStats.set(run.Apellido, opEntry);
            }
            opEntry.totalProduction += cant;
            opEntry.numberOfRuns += 1;
        }

        // Máquina stats
        if (machine) {
            machineProdAggregation.set(machine, (machineProdAggregation.get(machine) || 0) + cant);

            let mSum = machineSummaryMap.get(machine);
            if (!mSum) {
                mSum = {
                    machine,
                    group: run.Grupo_Maquina || '',
                    runs: 0,
                    production: 0,
                    netMinutes: 0,
                    downtimeMinutes: 0,
                    downtimeEvents: 0,
                    reasons: {}
                };
                machineSummaryMap.set(machine, mSum);
            }
            mSum.runs += 1;
            mSum.production += cant;
            mSum.netMinutes += hsTrab;
        }

        // Producción diaria
        if (dateStr) {
            if (dailyAggregationType === 'total') {
                dailyProdAggregation.set(dateStr, (dailyProdAggregation.get(dateStr) || 0) + cant);
            } else {
                const groupKey = dailyAggregationType === 'byShift' ? (run.Turno || 'Sin Turno') : machine;
                if (groupKey) {
                    let dayMap = dailyProdAggregation.get(dateStr);
                    if (!dayMap) {
                        dayMap = new Map();
                        dailyProdAggregation.set(dateStr, dayMap);
                    }
                    dayMap.set(groupKey, (dayMap.get(groupKey) || 0) + cant);
                }
            }

            // Tiempo de producción diario (Hs_Trab ya tiene descontadas las paradas en el CSV)
            if (!dailyTimeAggregation[dateStr]) {
                dailyTimeAggregation[dateStr] = { productionMinutes: 0, downtime: {} };
            }
            dailyTimeAggregation[dateStr].productionMinutes += Math.max(0, hsTrab);
        }
    }

    // 3. Downtime calculations from full dataChunk (each row is a downtime event)
    let totalDowntimeMinutes = 0;
    let totalDowntimeFrequency = 0;
    const downtimeAggregation = new Map();

    for (let i = 0; i < dataChunk.length; i++) {
        const row = dataChunk[i];
        const mins = row.Minutos || 0;
        const freq = row.Frecuencia > 0 ? row.Frecuencia : (mins > 0 ? 1 : 0);
        const reason = row.descrip_incidencia;
        const dateStr = row.dateStr || getLocalDateString(row.Fecha);
        const machine = row.Descrip_Maquina;

        totalDowntimeMinutes += mins;

        if (reason && mins > 0) {
            totalDowntimeFrequency += freq;

            let dEntry = downtimeAggregation.get(reason);
            if (!dEntry) {
                dEntry = { totalMinutes: 0, totalFrequency: 0 };
                downtimeAggregation.set(reason, dEntry);
            }
            dEntry.totalMinutes += mins;
            dEntry.totalFrequency += freq;

            if (dateStr) {
                if (!dailyTimeAggregation[dateStr]) {
                    dailyTimeAggregation[dateStr] = { productionMinutes: 0, downtime: {} };
                }
                dailyTimeAggregation[dateStr].downtime[reason] = (dailyTimeAggregation[dateStr].downtime[reason] || 0) + mins;
            }

            if (machine && machineSummaryMap.has(machine)) {
                const mSum = machineSummaryMap.get(machine);
                mSum.downtimeMinutes += mins;
                mSum.downtimeEvents += freq;
                mSum.reasons[reason] = (mSum.reasons[reason] || 0) + mins;
            }
        }
    }

    const kpiData = {
        totalProduction,
        totalDowntimeHours: totalDowntimeMinutes / 60,
        totalDowntimeMinutes,
        totalDowntimeFrequency,
        totalNetProductionMinutes,
        totalPlannedMinutes: totalNetProductionMinutes + totalDowntimeMinutes,
        numberOfProductionRuns
    };

    const downtimeData = Array.from(downtimeAggregation.entries()).map(([reason, data]) => ({ reason, ...data }));
    const avgProdByOperatorData = Array.from(operatorStats.entries()).map(([op, data]) => ({ ...data, category: op }));
    const prodByMachineData = Array.from(machineProdAggregation.entries()).map(([m, val]) => ({ category: m, value: val }));
    const machineSummaryData = Array.from(machineSummaryMap.values());

    return {
        kpiData,
        downtimeData,
        avgProdByOperatorData,
        prodByMachineData,
        machineSummaryData,
        dailyProdAggregation,
        dailyTimeAggregation
    };
}

// --- MESSAGE HANDLER ---
self.onmessage = function (e) {
    const { type, payload } = e.data;

    if (type === 'process_chunk') {
        const { jobId, chunk, dailyAggregationType } = payload;
        const results = processDataChunk(chunk, dailyAggregationType);

        self.postMessage({
            type: 'chunk_processed',
            payload: {
                jobId,
                ...results
            }
        });
    }
};
