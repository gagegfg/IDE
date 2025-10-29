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

    runGroups.forEach(runGroup => {
        const firstRow = runGroup[0];
        const runQuantity = firstRow.Cantidad || 0;
        const runPlannedMinutes = firstRow.Hs_Trab || 0;
        const operator = firstRow.Apellido;
        const machine = firstRow.Descrip_Maquina;

        totalProduction += runQuantity;
        totalPlannedMinutes += runPlannedMinutes;

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

        runGroup.forEach(row => {
            const downtimeMinutes = row.Minutos || 0;
            const reason = row.descrip_incidencia;
            totalDowntimeMinutes += downtimeMinutes;

            if (reason && downtimeMinutes > 0) {
                if (!downtimeAggregation[reason]) {
                    downtimeAggregation[reason] = { totalMinutes: 0, totalFrequency: 0 };
                }
                downtimeAggregation[reason].totalMinutes += downtimeMinutes;
                // Frequency is counted once per unique incident row that has minutes
                downtimeAggregation[reason].totalFrequency += 1; 
            }
        });
    });

    // Final KPI data for this chunk
    const kpiData = {
        totalProduction,
        totalDowntimeHours: totalDowntimeMinutes / 60,
        totalPlannedMinutes,
        numberOfProductionRuns
    };

    // Final downtime data for this chunk
    const downtimeData = Object.keys(downtimeAggregation).map(reason => ({
        reason,
        totalMinutes: downtimeAggregation[reason].totalMinutes,
        totalFrequency: downtimeAggregation[reason].totalFrequency
    }));

    // Final operator data for this chunk
    const avgProdByOperatorData = Object.keys(operatorStats).map(op => ({
        category: op,
        totalProduction: operatorStats[op].totalProduction,
        numberOfRuns: operatorStats[op].numberOfRuns
    }));

    // Final machine data for this chunk
    const prodByMachineData = Object.keys(machineProdAggregation).map(m => ({
        category: m,
        value: machineProdAggregation[m]
    }));

    return { kpiData, downtimeData, avgProdByOperatorData, prodByMachineData };
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