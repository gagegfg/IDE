importScripts('https://cdn.jsdelivr.net/npm/papaparse@5.3.2/papaparse.min.js');

// --- UTILITY FUNCTIONS ---
function getLocalDateString(d) {
    if (!d) return null;
    const date = new Date(d);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// --- MAIN CALCULATION FUNCTION ---
function processDataChunk(dataChunk, dailyAggregationType) {
    // --- 1. De-duplicate Production Runs within the chunk ---
    const uniqueRuns = new Map();
    dataChunk.forEach(row => {
        if (row.IdProduccion) {
            const key = `${row.IdProduccion}-${row.Fecha.getTime()}-${row.Turno}-${row.Descrip_Maquina}`;
            if (!uniqueRuns.has(key)) {
                uniqueRuns.set(key, row);
            }
        }
    });
    const uniqueRunData = Array.from(uniqueRuns.values());

    // --- 2. Calculate KPIs and Aggregations ---
    // Production-based calculations use uniqueRunData
    const totalProduction = uniqueRunData.reduce((sum, row) => sum + row.Cantidad, 0);
    const totalPlannedMinutes = uniqueRunData.reduce((sum, row) => sum + row.Hs_Trab, 0);
    const numberOfProductionRuns = uniqueRunData.length;

    // Downtime is calculated from the full chunk, as each row is a valid event
    const totalDowntimeMinutes = dataChunk.reduce((sum, row) => sum + row.Minutos, 0);

    const kpiData = {
        totalProduction,
        totalDowntimeHours: totalDowntimeMinutes / 60,
        totalPlannedMinutes,
        numberOfProductionRuns
    };

    // --- 3. Chart-specific Aggregations ---
    const downtimeAggregation = new Map();
    dataChunk.forEach(row => {
        if (row.descrip_incidencia && row.Minutos > 0) {
            if (!downtimeAggregation.has(row.descrip_incidencia)) {
                downtimeAggregation.set(row.descrip_incidencia, { totalMinutes: 0, totalFrequency: 0 });
            }
            const entry = downtimeAggregation.get(row.descrip_incidencia);
            entry.totalMinutes += row.Minutos;
            entry.totalFrequency += 1;
        }
    });
    const downtimeData = Array.from(downtimeAggregation.entries()).map(([reason, data]) => ({ reason, ...data }));

    const operatorStats = new Map();
    uniqueRunData.forEach(row => {
        if (row.Apellido) {
            if (!operatorStats.has(row.Apellido)) {
                operatorStats.set(row.Apellido, { totalProduction: 0, numberOfRuns: 0 });
            }
            const entry = operatorStats.get(row.Apellido);
            entry.totalProduction += row.Cantidad;
            entry.numberOfRuns += 1;
        }
    });
    const avgProdByOperatorData = Array.from(operatorStats.entries()).map(([op, data]) => ({ ...data, category: op }));

    const machineProdAggregation = new Map();
    uniqueRunData.forEach(row => {
        if (row.Descrip_Maquina) {
            const current = machineProdAggregation.get(row.Descrip_Maquina) || 0;
            machineProdAggregation.set(row.Descrip_Maquina, current + row.Cantidad);
        }
    });
    const prodByMachineData = Array.from(machineProdAggregation.entries()).map(([m, val]) => ({ category: m, value: val }));

    // --- New, intermediate daily production aggregation ---
    const dailyProdAggregation = new Map();
    uniqueRunData.forEach(row => {
        const dateStr = getLocalDateString(row.Fecha);
        if (!dateStr) return;

        if (dailyAggregationType === 'total') {
            const current = dailyProdAggregation.get(dateStr) || 0;
            dailyProdAggregation.set(dateStr, current + row.Cantidad);
        } else {
            const groupKey = dailyAggregationType === 'byShift' ? row.Turno : row.Descrip_Maquina;
            if (!groupKey) return;
            if (!dailyProdAggregation.has(dateStr)) {
                dailyProdAggregation.set(dateStr, new Map());
            }
            const dayMap = dailyProdAggregation.get(dateStr);
            const current = dayMap.get(groupKey) || 0;
            dayMap.set(groupKey, current + row.Cantidad);
        }
    });

    // --- Daily Time Distribution (row-intensive) ---
    const dailyTimeAggregation = {};
    dataChunk.forEach(row => {
        const dateStr = getLocalDateString(row.Fecha);
        if (!dateStr) return;

        if (!dailyTimeAggregation[dateStr]) {
            dailyTimeAggregation[dateStr] = { productionMinutes: 0, downtime: {} };
        }
        const downtimeMinutes = row.Minutos || 0;
        const reason = row.descrip_incidencia;
        if (reason && downtimeMinutes > 0) {
            dailyTimeAggregation[dateStr].downtime[reason] = (dailyTimeAggregation[dateStr].downtime[reason] || 0) + downtimeMinutes;
        }
    });
    // Assign production time based on unique runs to avoid duplication
    uniqueRunData.forEach(run => {
        const dateStr = getLocalDateString(run.Fecha);
        if (!dateStr) return;
        if (!dailyTimeAggregation[dateStr]) {
            dailyTimeAggregation[dateStr] = { productionMinutes: 0, downtime: {} };
        }
        const runDowntime = dataChunk.filter(r => r.IdProduccion === run.IdProduccion).reduce((sum, r) => sum + (r.Minutos || 0), 0);
        dailyTimeAggregation[dateStr].productionMinutes += Math.max(0, (run.Hs_Trab || 0) - runDowntime);
    });

    return { kpiData, downtimeData, avgProdByOperatorData, prodByMachineData, dailyProdAggregation, dailyTimeAggregation };
}


// --- MESSAGE HANDLER ---
self.onmessage = function(e) {
    const { type, payload } = e.data;

    if (type === 'process_chunk') {
        const { jobId, chunk, dailyAggregationType } = payload;
        
        // The main processing function now takes the chunk and the aggregation type
        const results = processDataChunk(chunk, dailyAggregationType);

        self.postMessage({
            type: 'chunk_processed',
            payload: { 
                jobId, // Echo the Job ID back
                ...results
            }
        });
    }
};
