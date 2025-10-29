importScripts('https://cdn.jsdelivr.net/npm/papaparse@5.3.2/papaparse.min.js');

let originalData = [];
let workers = [];
const numWorkers = navigator.hardwareConcurrency || 4;

let jobs = new Map();
let nextJobId = 0;

// --- UTILITY & SETUP ---

function parseDate(dateString) {
    if (!dateString) return null;
    const parts = dateString.split('/');
    if (parts.length === 3) {
        const day = parseInt(parts[0], 10), month = parseInt(parts[1], 10) - 1, year = parseInt(parts[2], 10);
        if (!isNaN(day) && !isNaN(month) && !isNaN(year)) return new Date(year, month, day);
    }
    return null;
}

function processData(data) {
    return data.map(row => {
        row.Cantidad = parseInt(row.Cantidad) || 0;
        row.Minutos = parseInt(row.Minutos) || 0;
        row.Frecuencia = parseInt(row.Frecuencia) || 0;
        row.Hs_Trab = parseFloat(String(row.Hs_Trab).replace(',', '.')) || 0;
        row.Objetivo = parseInt(row.Objetivo) || 0;
        row.Fecha = parseDate(row.Fecha);
        return row;
    }).filter(row => row.Fecha instanceof Date && !isNaN(row.Fecha));
}

function getFilteredData(filters) {
    const { dateRange, selectedMachines, selectedShifts, selectedOperator, selectedMachineGroup } = filters;
    
    return originalData.filter(row => {
        const rowDate = new Date(row.Fecha);
        const startDate = dateRange[0] ? new Date(dateRange[0]) : null;
        if(startDate) startDate.setHours(0,0,0,0);
        const endDate = dateRange[1] ? new Date(dateRange[1]) : null;
        if(endDate) endDate.setHours(23,59,59,999);

        const isDateInRange = dateRange.length === 2 ? rowDate >= startDate && rowDate <= endDate : true;
        const isMachineSelected = selectedMachines.length > 0 ? selectedMachines.includes(row.Descrip_Maquina) : true;
        const isShiftSelected = selectedShifts.length > 0 ? selectedShifts.includes(row.Turno) : true;
        const isOperatorSelected = selectedOperator ? row.Apellido === selectedOperator : true;
        const isMachineGroupSelected = selectedMachineGroup ? row.Grupo_Maquina === selectedMachineGroup : true;

        return isDateInRange && isMachineSelected && isShiftSelected && isOperatorSelected && isMachineGroupSelected;
    });
}

function setupWorkers() {
    workers.forEach(w => w.terminate());
    workers = [];
    for (let i = 0; i < numWorkers; i++) {
        const worker = new Worker('task-worker.js');
        worker.onmessage = (event) => {
            const { jobId, ...payload } = event.data.payload;
            const job = jobs.get(jobId);

            if (!job) return;

            job.results.push(payload);
            job.workersFinished++;

            const progress = 15 + Math.round((job.workersFinished / job.totalChunks) * 70);
            self.postMessage({ type: 'progress', payload: { progress: progress, status: `Calculando... ${job.workersFinished}/${job.totalChunks} completados.` } });

            if (job.workersFinished === job.totalChunks) {
                self.postMessage({ type: 'progress', payload: { progress: 85, status: 'Agregando resultados...' } });
                aggregateResults(job.results, job.filteredData, job.filters);
                jobs.delete(jobId);
            }
        };
        workers.push(worker);
    }
}

// --- RESULT AGGREGATION (REDUCER) ---

function aggregateResults(results, filteredData, filters) {
    if (results.length === 0) {
        const emptyKpi = { totalProduction: 0, totalDowntimeHours: 0, availability: 0, efficiency: 0 };
        const emptyCharts = { dailyProdData: { series: [], categories: [] }, prodByMachineData: [], avgProdByOperatorData: [], downtimeComboData: [], dailyTimeData: { series: [], categories: [] } };
        self.postMessage({ type: 'update_dashboard', payload: { filteredData, kpiData: emptyKpi, chartsData: emptyCharts, summaryData: { topReason: 'N/A' } } });
        return;
    }

    // --- Aggregate KPIs from partial results ---
    const totalProduction = results.reduce((sum, res) => sum + res.kpiData.totalProduction, 0);
    const totalDowntimeHours = results.reduce((sum, res) => sum + res.kpiData.totalDowntimeHours, 0);
    const totalPlannedMinutes = results.reduce((sum, res) => sum + res.kpiData.totalPlannedMinutes, 0);
    const totalRuns = results.reduce((sum, res) => sum + res.kpiData.numberOfProductionRuns, 0);

    const runTimeMinutes = totalPlannedMinutes - (totalDowntimeHours * 60);
    const availability = totalPlannedMinutes > 0 ? Math.max(0, runTimeMinutes / totalPlannedMinutes) : 0;
    const efficiency = totalRuns > 0 ? totalProduction / totalRuns : 0;
    const finalKpiData = { totalProduction, totalDowntimeHours, availability, efficiency };

    // --- Aggregate Chart Data from partial results ---
    const downtimeMap = new Map();
    results.flatMap(r => r.downtimeData).forEach(d => {
        if (!downtimeMap.has(d.reason)) { downtimeMap.set(d.reason, { totalMinutes: 0, totalFrequency: 0 }); }
        const existing = downtimeMap.get(d.reason);
        existing.totalMinutes += d.totalMinutes;
        existing.totalFrequency += d.totalFrequency;
    });
    const finalDowntimeData = Array.from(downtimeMap.entries()).map(([reason, data]) => ({ reason, ...data }));

    const summaryData = createSummaryData(finalKpiData, finalDowntimeData);

    const operatorDataMap = new Map();
    results.flatMap(r => r.avgProdByOperatorData).forEach(opData => {
        if (!operatorDataMap.has(opData.category)) { operatorDataMap.set(opData.category, { totalProduction: 0, numberOfRuns: 0 }); }
        const existing = operatorDataMap.get(opData.category);
        existing.totalProduction += opData.totalProduction;
        existing.numberOfRuns += opData.numberOfRuns;
    });
    const finalAvgProdByOperator = Array.from(operatorDataMap.entries()).map(([operator, data]) => {
        const average = data.numberOfRuns > 0 ? data.totalProduction / data.numberOfRuns : 0;
        return { category: operator, value: average };
    }).sort((a, b) => b.value - a.value);

    const machineDataMap = new Map();
    results.flatMap(r => r.prodByMachineData).forEach(mData => {
        machineDataMap.set(mData.category, (machineDataMap.get(mData.category) || 0) + mData.value);
    });
    const finalProdByMachine = Array.from(machineDataMap.entries()).map(([category, value]) => ({ category, value })).sort((a, b) => b.value - a.value);

    // --- Reduce and format daily chart data ---
    const dailyProdData = formatDailyProduction(results.map(r => r.dailyProdAggregation), filters.dailyAggregationType);
    const dailyTimeData = formatDailyTimeDistribution(results.map(r => r.dailyTimeAggregation));

    const finalChartsData = { dailyProdData, prodByMachineData: finalProdByMachine, avgProdByOperatorData: finalAvgProdByOperator, downtimeComboData: finalDowntimeData, dailyTimeData };

    self.postMessage({ type: 'progress', payload: { progress: 95, status: 'Finalizando...' } });
    self.postMessage({ type: 'update_dashboard', payload: { filteredData, kpiData: finalKpiData, chartsData: finalChartsData, summaryData } });
}

function createSummaryData(kpiData, downtimeData) {
    if (!kpiData || downtimeData.length === 0) return { topReason: 'N/A' };
    const sortedDowntime = [...downtimeData].sort((a, b) => b.totalMinutes - a.totalMinutes);
    const topReason = sortedDowntime[0]?.reason || 'N/A';
    const topReasonMins = sortedDowntime[0]?.totalMinutes || 0;
    const totalDowntimeMins = kpiData.totalDowntimeHours * 60;
    const topReasonPercentage = totalDowntimeMins > 0 ? (topReasonMins / totalDowntimeMins * 100).toFixed(0) : 0;
    return { availabilityPercentage: (kpiData.availability * 100).toFixed(1), topReason, topReasonPercentage };
}

function formatDailyProduction(partialResults, aggType) {
    const finalDailyProd = new Map();

    partialResults.forEach(chunkMap => {
        chunkMap.forEach((value, dateStr) => {
            if (aggType === 'total') {
                finalDailyProd.set(dateStr, (finalDailyProd.get(dateStr) || 0) + value);
            } else { // byShift or byMachine
                if (!finalDailyProd.has(dateStr)) {
                    finalDailyProd.set(dateStr, new Map());
                }
                const finalDayMap = finalDailyProd.get(dateStr);
                value.forEach((groupValue, groupKey) => {
                    finalDayMap.set(groupKey, (finalDayMap.get(groupKey) || 0) + groupValue);
                });
            }
        });
    });

    const sortedDates = Array.from(finalDailyProd.keys()).sort();
    const categories = sortedDates.map(date => new Date(`${date}T00:00:00`).getTime());
    let series = [];

    if (aggType === 'total') {
        const seriesData = sortedDates.map(date => finalDailyProd.get(date));
        series.push({ name: 'Producción Total', data: seriesData });
    } else {
        const allGroupKeys = new Set();
        finalDailyProd.forEach(groupMap => {
            groupMap.forEach((_, key) => allGroupKeys.add(key));
        });
        const sortedGroupKeys = Array.from(allGroupKeys).sort();

        series = sortedGroupKeys.map(key => ({
            name: key,
            data: sortedDates.map(date => finalDailyProd.get(date).get(key) || 0)
        }));
    }

    return { series, categories };
}

function formatDailyTimeDistribution(partialResults) {
    const finalDailyTime = {};
    const allReasons = new Set();

    partialResults.forEach(dailyResult => {
        for (const dateStr in dailyResult) {
            if (!finalDailyTime[dateStr]) {
                finalDailyTime[dateStr] = { productionMinutes: 0, downtime: {} };
            }
            const dayData = dailyResult[dateStr];
            finalDailyTime[dateStr].productionMinutes += dayData.productionMinutes;
            for (const reason in dayData.downtime) {
                finalDailyTime[dateStr].downtime[reason] = (finalDailyTime[dateStr].downtime[reason] || 0) + dayData.downtime[reason];
                allReasons.add(reason);
            }
        }
    });

    const sortedDates = Object.keys(finalDailyTime).sort();
    const sortedReasons = Array.from(allReasons).sort();

    const series = [{ name: 'Producción', data: [] }];
    sortedReasons.forEach(reason => series.push({ name: reason, data: [] }));

    const reasonToIndexMap = sortedReasons.reduce((acc, reason, index) => {
        acc[reason] = index + 1; // +1 for 'Producción' series
        return acc;
    }, {});

    sortedDates.forEach(dateStr => {
        const dayData = finalDailyTime[dateStr];
        series[0].data.push(parseFloat((dayData.productionMinutes / 60).toFixed(1)));
        sortedReasons.forEach(reason => {
            const seriesIndex = reasonToIndexMap[reason];
            const downtimeMinutes = dayData.downtime[reason] || 0;
            series[seriesIndex].data.push(parseFloat((downtimeMinutes / 60).toFixed(1)));
        });
    });

    return {
        series: series,
        categories: sortedDates.map(date => new Date(`${date}T00:00:00`).getTime())
    };
}

// --- MESSAGE HANDLER ---

setupWorkers();

self.onmessage = function(e) {
    const { type, payload } = e.data;

    if (type === 'load_data') {
        self.postMessage({ type: 'progress', payload: { progress: 0, status: 'Cargando datos CSV...' } });
        Papa.parse(payload.url, {
            download: true, header: true, delimiter: ';', skipEmptyLines: true,
            transformHeader: header => header.trim().replace(/[\W]+/g, '_'),
            complete: function(results) {
                originalData = processData(results.data);
                const today = new Date();
                const startOfPreviousMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                self.postMessage({
                    type: 'data_loaded',
                    payload: {
                        uniqueMachines: [...new Set(originalData.map(row => row.Descrip_Maquina))].filter(Boolean).sort(),
                        uniqueShifts: [...new Set(originalData.map(row => row.Turno))].filter(Boolean).sort(),
                        uniqueMachineGroups: [...new Set(originalData.map(row => row.Grupo_Maquina))].filter(Boolean).sort()
                    }
                });
                applyFiltersAndPost({ dateRange: [startOfPreviousMonth, today], selectedMachines: [], selectedShifts: [], selectedMachineGroup: null, isExtended: false, dailyAggregationType: 'total' });
            },
            error: err => {
                self.postMessage({ type: 'error', payload: `Error al cargar CSV: ${err.message}` });
            }
        });
    }
    
    if (type === 'apply_filters') {
        applyFiltersAndPost(payload);
    }
};

function applyFiltersAndPost(filters) {
    self.postMessage({ type: 'progress', payload: { progress: 5, status: 'Filtrando y agrupando datos...' } });
    const filteredData = getFilteredData(filters);

    const chunks = [];
    const chunkSize = Math.ceil(filteredData.length / numWorkers);
    if (filteredData.length > 0 && chunkSize > 0) {
        for (let i = 0; i < filteredData.length; i += chunkSize) {
            chunks.push(filteredData.slice(i, i + chunkSize));
        }
    }

    const jobId = nextJobId++;
    jobs.set(jobId, {
        results: [],
        workersFinished: 0,
        totalChunks: chunks.length,
        filters: filters,
        filteredData: filteredData
    });

    if (chunks.length === 0) {
        aggregateResults([], filteredData, filters);
        jobs.delete(jobId);
        return;
    }

    self.postMessage({ type: 'progress', payload: { progress: 15, status: `Distribuyendo carga en ${chunks.length} núcleos...` } });

    chunks.forEach((chunk, index) => {
        if (workers[index]) {
            workers[index].postMessage({ 
                type: 'process_chunk', 
                payload: { 
                    jobId: jobId,
                    chunk: chunk,
                    dailyAggregationType: filters.dailyAggregationType
                }
            });
        }
    });
}