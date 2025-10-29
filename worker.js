importScripts('https://cdn.jsdelivr.net/npm/papaparse@5.3.2/papaparse.min.js');

let originalData = [];
let workers = [];
const numWorkers = navigator.hardwareConcurrency || 4;

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
    for (let i = 0; i < numWorkers; i++) {
        workers.push(new Worker('task-worker.js'));
    }
}

// --- RESULT AGGREGATION ---

function aggregateResults(results, filteredData, filters) {
    // 1. Aggregate KPIs
    const totalProduction = results.reduce((sum, res) => sum + res.kpiData.totalProduction, 0);
    const totalDowntimeHours = results.reduce((sum, res) => sum + res.kpiData.totalDowntimeHours, 0);
    const totalPlannedMinutes = results.reduce((sum, res) => sum + res.kpiData.totalPlannedMinutes, 0);
    const totalRuns = results.reduce((sum, res) => sum + res.kpiData.numberOfProductionRuns, 0);

    const runTimeMinutes = totalPlannedMinutes - (totalDowntimeHours * 60);
    const availability = totalPlannedMinutes > 0 ? Math.max(0, runTimeMinutes / totalPlannedMinutes) : 0;
    const efficiency = totalRuns > 0 ? totalProduction / totalRuns : 0;

    const finalKpiData = {
        totalProduction,
        totalDowntimeHours,
        availability,
        efficiency
    };

    // 2. Aggregate Downtime Data
    const downtimeMap = new Map();
    results.forEach(res => {
        res.downtimeData.forEach(d => {
            if (!downtimeMap.has(d.reason)) {
                downtimeMap.set(d.reason, { totalMinutes: 0, totalFrequency: 0 });
            }
            const existing = downtimeMap.get(d.reason);
            existing.totalMinutes += d.totalMinutes;
            existing.totalFrequency += d.totalFrequency;
        });
    });
    const finalDowntimeData = Array.from(downtimeMap.entries()).map(([reason, data]) => ({ reason, ...data }));

    // 3. Create Summary
    const summaryData = createSummaryData(finalKpiData, finalDowntimeData);

    // 4. Aggregate Chart Data (simple merge and re-aggregate)
    const finalProdByMachine = aggregateAndSort(results.flatMap(r => r.prodByMachineData), 'category', 'value');
    const finalAvgProdByOperator = aggregateAndSort(results.flatMap(r => r.avgProdByOperatorData), 'category', 'value');

    // For time-based charts, we can just use the first worker's result as they are not additive
    // but are based on the full date range, which each worker has.
    const dailyProdData = results[0]?.dailyProdData || { series: [], categories: [] };
    const dailyTimeData = results[0]?.dailyTimeData || { series: [], categories: [] };

    const finalChartsData = {
        dailyProdData,
        prodByMachineData: finalProdByMachine,
        avgProdByOperatorData: finalAvgProdByOperator,
        downtimeComboData: finalDowntimeData,
        dailyTimeData
    };

    self.postMessage({ type: 'progress', payload: { progress: 95, status: 'Finalizando...' } });
    self.postMessage({
        type: 'update_dashboard',
        payload: { 
            filteredData, 
            kpiData: finalKpiData, 
            chartsData: finalChartsData, 
            summaryData 
        }
    });
}

function aggregateAndSort(data, categoryField, valueField) {
    const aggregation = new Map();
    data.forEach(item => {
        aggregation.set(item[categoryField], (aggregation.get(item[categoryField]) || 0) + item[valueField]);
    });
    let aggregatedArray = Array.from(aggregation.entries()).map(([key, val]) => ({ [categoryField]: key, [valueField]: val }));
    return aggregatedArray.sort((a, b) => b[valueField] - a[valueField]);
}

function createSummaryData(kpiData, downtimeData) {
    if (!kpiData || downtimeData.length === 0) return { topReason: 'N/A' };
    const sortedDowntime = [...downtimeData].sort((a, b) => b.totalMinutes - a.totalMinutes);
    const topReason = sortedDowntime[0].reason;
    const topReasonMins = sortedDowntime[0].totalMinutes;
    const totalDowntimeMins = kpiData.totalDowntimeHours * 60;
    const topReasonPercentage = totalDowntimeMins > 0 ? (topReasonMins / totalDowntimeMins * 100).toFixed(0) : 0;
    return {
        availabilityPercentage: (kpiData.availability * 100).toFixed(1),
        topReason,
        topReasonPercentage
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
    self.postMessage({ type: 'progress', payload: { progress: 5, status: 'Filtrando datos...' } });
    const filteredData = getFilteredData(filters);
    
    const chunks = [];
    const chunkSize = Math.ceil(filteredData.length / numWorkers);
    if (filteredData.length > 0 && chunkSize > 0) {
        for (let i = 0; i < filteredData.length; i += chunkSize) {
            chunks.push(filteredData.slice(i, i + chunkSize));
        }
    }

    if (chunks.length === 0) {
        // Handle case with no data after filtering
        aggregateResults([], filteredData, filters);
        return;
    }

    let results = [];
    let workersFinished = 0;
    const totalChunks = chunks.length; // Number of workers that will actually do work

    self.postMessage({ type: 'progress', payload: { progress: 15, status: `Distribuyendo carga en ${totalChunks} núcleos...` } });

    workers.forEach((worker, index) => {
        worker.onmessage = (event) => {
            results.push(event.data.payload);
            workersFinished++;
            
            const progress = 15 + Math.round((workersFinished / totalChunks) * 70);
            self.postMessage({ type: 'progress', payload: { progress: progress, status: `Calculando... ${workersFinished}/${totalChunks} completados.` } });

            if (workersFinished === totalChunks) {
                self.postMessage({ type: 'progress', payload: { progress: 85, status: 'Agregando resultados...' } });
                aggregateResults(results, filteredData, filters);
            }
        };

        const chunk = chunks[index];
        if (chunk) {
            worker.postMessage({ 
                type: 'process_chunk', 
                payload: { 
                    dataChunk: chunk, 
                    dateRange: filters.dateRange, 
                    isExtended: filters.isExtended, 
                    dailyAggregationType: filters.dailyAggregationType 
                }
            });
        } else {
            // If a worker has no chunk, consider it 'finished' immediately
            workersFinished++;
            if (workersFinished === numWorkers) {
                 aggregateResults(results, filteredData, filters);
            }
        }
    });
}