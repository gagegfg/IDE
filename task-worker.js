importScripts('https://cdn.jsdelivr.net/npm/papaparse@5.3.2/papaparse.min.js');

// --- UTILITY FUNCTIONS ---
function getLocalDateString(d) {
    const date = new Date(d);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// --- CALCULATION FUNCTIONS ---

// Processes an array of "run groups". Each group is an array of rows for a single production run.
function processRunGroups(runGroups) {
    let totalProduction = 0;
    let totalPlannedMinutes = 0;
    let totalDowntimeMinutes = 0;
    const numberOfProductionRuns = runGroups.length;

    const downtimeAggregation = {};
    const operatorStats = {};
    const machineProdAggregation = {};
    const dailyProdAggregation = {};
    const dailyTimeAggregation = {};

    runGroups.forEach(runGroup => {
        const firstRow = runGroup[0];
        if (!firstRow) return;

        const runQuantity = firstRow.Cantidad || 0;
        const runPlannedMinutes = firstRow.Hs_Trab || 0;
        const operator = firstRow.Apellido;
        const machine = firstRow.Descrip_Maquina;
        const dateStr = getLocalDateString(firstRow.Fecha);

        // --- Aggregate totals for KPIs ---
        totalProduction += runQuantity;
        totalPlannedMinutes += runPlannedMinutes;

        // --- Aggregate for charts ---
        if (machine) {
            machineProdAggregation[machine] = (machineProdAggregation[machine] || 0) + runQuantity;
        }
        if (operator) {
            if (!operatorStats[operator]) {
                operatorStats[operator] = { totalProduction: 0, numberOfRuns: 0 };
            }
            operatorStats[operator].totalProduction += runQuantity;
            operatorStats[operator].numberOfRuns += 1;
        }
        if (dateStr) {
            dailyProdAggregation[dateStr] = (dailyProdAggregation[dateStr] || 0) + runQuantity;
        }

        // --- Aggregate row-level data (downtime) ---
        runGroup.forEach(row => {
            const downtimeMinutes = row.Minutos || 0;
            const reason = row.descrip_incidencia;
            totalDowntimeMinutes += downtimeMinutes;

            if (dateStr) {
                if (!dailyTimeAggregation[dateStr]) {
                    dailyTimeAggregation[dateStr] = { productionMinutes: 0, downtime: {} };
                }
                if (reason && downtimeMinutes > 0) {
                    dailyTimeAggregation[dateStr].downtime[reason] = (dailyTimeAggregation[dateStr].downtime[reason] || 0) + downtimeMinutes;
                }
            }
        });
        
        // Add production minutes for the run to the daily time aggregation
        if (dateStr) {
             if (!dailyTimeAggregation[dateStr]) {
                dailyTimeAggregation[dateStr] = { productionMinutes: 0, downtime: {} };
            }
            const runDowntime = runGroup.reduce((sum, r) => sum + (r.Minutos || 0), 0);
            dailyTimeAggregation[dateStr].productionMinutes += Math.max(0, runPlannedMinutes - runDowntime);
        }
    });

    // --- Finalize partial results for this chunk ---
    const kpiData = {
        totalProduction,
        totalDowntimeHours: totalDowntimeMinutes / 60,
        totalPlannedMinutes,
        numberOfProductionRuns
    };

    const downtimeData = Object.keys(downtimeAggregation).map(reason => ({
        reason,
        totalMinutes: downtimeAggregation[reason].totalMinutes,
        totalFrequency: downtimeAggregation[reason].totalFrequency
    }));

    const avgProdByOperatorData = Object.keys(operatorStats).map(op => ({
        category: op,
        totalProduction: operatorStats[op].totalProduction,
        numberOfRuns: operatorStats[op].numberOfRuns
    }));

    const prodByMachineData = Object.keys(machineProdAggregation).map(m => ({
        category: m,
        value: machineProdAggregation[m]
    }));

    return { kpiData, downtimeData, avgProdByOperatorData, prodByMachineData, dailyProdAggregation, dailyTimeAggregation };
}


// --- MESSAGE HANDLER ---

self.onmessage = function(e) {
    const { type, payload } = e.data;

    if (type === 'process_chunk') {
        const { jobId, runGroups } = payload;
        
        const results = processRunGroups(runGroups);

        self.postMessage({
            type: 'chunk_processed',
            payload: { 
                jobId, // Echo the Job ID back
                ...results
            }
        });
    }
};
