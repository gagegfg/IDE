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

// --- RESULT AGGREGATION ---

function aggregateResults(results, filteredData, filters) {
    if (results.length === 0) {
        const emptyKpi = { totalProduction: 0, totalDowntimeHours: 0, availability: 0, efficiency: 0 };
        const emptyCharts = { dailyProdData: { series: [], categories: [] }, prodByMachineData: [], avgProdByOperatorData: [], downtimeComboData: [], dailyTimeData: { series: [], categories: [] } };
        self.postMessage({ type: 'update_dashboard', payload: { filteredData, kpiData: emptyKpi, chartsData: emptyCharts, summaryData: { topReason: 'N/A' } } });
        return;
    }

    const totalProduction = results.reduce((sum, res) => sum + res.kpiData.totalProduction, 0);
    const totalDowntimeHours = results.reduce((sum, res) => sum + res.kpiData.totalDowntimeHours, 0);
    const totalPlannedMinutes = results.reduce((sum, res) => sum + res.kpiData.totalPlannedMinutes, 0);
    const totalRuns = results.reduce((sum, res) => sum + res.kpiData.numberOfProductionRuns, 0);

    const runTimeMinutes = totalPlannedMinutes - (totalDowntimeHours * 60);
    const availability = totalPlannedMinutes > 0 ? Math.max(0, runTimeMinutes / totalPlannedMinutes) : 0;
    const efficiency = totalRuns > 0 ? totalProduction / totalRuns : 0;

    const finalKpiData = { totalProduction, totalDowntimeHours, availability, efficiency };

    const downtimeMap = new Map();
    results.flatMap(r => r.downtimeData).forEach(d => {
        if (!downtimeMap.has(d.reason)) {
            downtimeMap.set(d.reason, { totalMinutes: 0, totalFrequency: 0 });
        }
        const existing = downtimeMap.get(d.reason);
        existing.totalMinutes += d.totalMinutes;
        existing.totalFrequency += d.totalFrequency;
    });
    const finalDowntimeData = Array.from(downtimeMap.entries()).map(([reason, data]) => ({ reason, ...data }));

    const summaryData = createSummaryData(finalKpiData, finalDowntimeData);

    const operatorDataMap = new Map();
    results.flatMap(r => r.avgProdByOperatorData).forEach(opData => {
        if (!operatorDataMap.has(opData.category)) {
            operatorDataMap.set(opData.category, { totalProduction: 0, numberOfRuns: 0 });
        }
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

    const { dateRange, isExtended, dailyAggregationType } = filters;
    const dailyProdData = aggregateDailyProduction(filteredData, dateRange, isExtended, dailyAggregationType);
    const dailyTimeData = aggregateDailyTimeDistribution(filteredData, dateRange);

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

const { aggregateDailyProduction, aggregateDailyTimeDistribution } = (() => {
    function getLocalDateString(d) {
        const date = new Date(d);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    function getStartOfWeek(d) {
        const date = new Date(d);
        const day = date.getDay();
        const diff = date.getDate() - day + (day === 0 ? -6 : 1);
        date.setHours(0, 0, 0, 0);
        return new Date(date.setDate(diff));
    }
    function generateDateRange(startDate, endDate) {
        const dates = [];
        let currentDate = new Date(startDate);
        currentDate.setHours(0, 0, 0, 0);
        const finalEndDate = new Date(endDate);
        finalEndDate.setHours(0, 0, 0, 0);
        while (currentDate <= finalEndDate) {
            dates.push(new Date(currentDate));
            currentDate.setDate(currentDate.getDate() + 1);
        }
        return dates;
    }

    function aggregateDaily(data, dateRange, aggregationType = 'total') {
        if (aggregationType === 'byShift') {
            const productionByShift = new Map();
            const allDates = new Set();
            const seenProdIds = new Set();
            data.forEach(row => {
                if (row.Fecha && row.Turno) {
                    const dateCategory = getLocalDateString(row.Fecha);
                    allDates.add(dateCategory);
                    if (!productionByShift.has(row.Turno)) { productionByShift.set(row.Turno, new Map()); }
                    const shiftMap = productionByShift.get(row.Turno);
                    if (!shiftMap.has(dateCategory)) { shiftMap.set(dateCategory, 0); }
                    const uniqueKey = `${dateCategory}-${row.Turno}-${row.IdProduccion}-${row.Descrip_Maquina}`;
                    if (row.IdProduccion && !seenProdIds.has(uniqueKey)) {
                        shiftMap.set(dateCategory, shiftMap.get(dateCategory) + row.Cantidad);
                        seenProdIds.add(uniqueKey);
                    }
                }
            });
            const sortedDates = [...allDates].sort();
            const finalSeries = [];
            for (const [shift, dateMap] of productionByShift.entries()) {
                const seriesData = sortedDates.map(date => {
                    const value = dateMap.get(date);
                    return (value > 0) ? value : null;
                });
                finalSeries.push({ name: `Turno ${shift}`, data: seriesData });
            }
            const dateHasValue = sortedDates.map((_, dateIndex) => finalSeries.some(series => series.data[dateIndex] !== null));
            const finalCategories = sortedDates.filter((_, index) => dateHasValue[index]).map(key => new Date(`${key}T00:00:00`).getTime());
            const filteredSeries = finalSeries.map(series => ({ name: series.name, data: series.data.filter((_, index) => dateHasValue[index]) }));
            return { series: filteredSeries, categories: finalCategories };
        } else {
            const aggregation = new Map();
            const seenProdIds = new Set();
            data.forEach(row => {
                if (row.Fecha) {
                    const dateCategory = getLocalDateString(row.Fecha);
                    if (!aggregation.has(dateCategory)) { aggregation.set(dateCategory, 0); }
                    const uniqueKey = `${dateCategory}-${row.IdProduccion}-${row.Descrip_Maquina}`;
                    if (row.IdProduccion && !seenProdIds.has(uniqueKey)) {
                        aggregation.set(dateCategory, aggregation.get(dateCategory) + row.Cantidad);
                        seenProdIds.add(uniqueKey);
                    }
                }
            });
            const finalEntries = [...aggregation.entries()].filter(([_, value]) => value > 0);
            finalEntries.sort((a, b) => a[0].localeCompare(b[0]));
            return { series: [{ name: 'Producción Diaria', data: finalEntries.map(entry => entry[1]) }], categories: finalEntries.map(entry => new Date(`${entry[0]}T00:00:00`).getTime()) };
        }
    }

    function aggregateWeeklyProduction(data, dateRange) {
        const aggregation = new Map();
        if (!dateRange || dateRange.length < 2) return { series: [], categories: [] };
        let currentDate = getStartOfWeek(dateRange[0]);
        const endDate = new Date(dateRange[1]);
        while(currentDate <= endDate) {
            aggregation.set(getLocalDateString(currentDate), 0);
            currentDate.setDate(currentDate.getDate() + 7);
        }
        const seenProdIds = new Set();
        data.forEach(row => {
            if (row.Fecha) {
                const d = getStartOfWeek(row.Fecha);
                const weekStartDate = getLocalDateString(d);
                const uniqueKey = `${weekStartDate}-${row.IdProduccion}-${row.Descrip_Maquina}`;
                if (row.IdProduccion && !seenProdIds.has(uniqueKey)) {
                    if(aggregation.has(weekStartDate)){ aggregation.set(weekStartDate, aggregation.get(weekStartDate) + row.Cantidad); }
                    seenProdIds.add(uniqueKey);
                }
            }
        });
        const sortedCategories = [...aggregation.keys()].sort();
        const seriesData = sortedCategories.map(key => aggregation.get(key));
        return { series: [{ name: 'Producción Semanal', data: seriesData }], categories: sortedCategories.map(key => new Date(`${key}T00:00:00`).getTime()) };
    }

    function aggregateDailyProduction(data, dateRange, isExtended, aggregationType) {
        if (!dateRange || dateRange.length < 2) return { series: [], categories: [] };
        const diffTime = Math.abs(new Date(dateRange[1]) - new Date(dateRange[0]));
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (isExtended && diffDays > 90) {
            return aggregateWeeklyProduction(data, dateRange);
        }
        return aggregateDaily(data, dateRange, aggregationType);
    }

    function aggregateDailyTimeDistribution(data, dateRange) {
        if (!dateRange || dateRange.length < 2) return { series: [], categories: [] };
        const allDowntimeReasons = [...new Set(data.map(row => row.descrip_incidencia).filter(Boolean))];
        const dataByDay = new Map();
        const allDays = generateDateRange(dateRange[0], dateRange[1]);
        allDays.forEach(day => { dataByDay.set(getLocalDateString(day), new Map()); });
        data.forEach(row => {
            if (!row.Fecha) return;
            const dayKey = getLocalDateString(row.Fecha);
            if (dataByDay.has(dayKey)) { dataByDay.get(dayKey).set(row.IdProduccion + '-' + row.Descrip_Maquina, row); }
        });
        const sortedDays = [...dataByDay.keys()].sort();
        const series = [{ name: 'Producción', data: [] }];
        const reasonToIndexMap = allDowntimeReasons.reduce((acc, reason, index) => {
            acc[reason] = index + 1;
            series.push({ name: reason, data: [] });
            return acc;
        }, {});
        sortedDays.forEach(day => {
            const dayDataRows = Array.from(dataByDay.get(day).values());
            const uniqueProductions = new Map();
            let totalDowntimeMinutes = 0;
            dayDataRows.forEach(row => {
                totalDowntimeMinutes += row.Minutos || 0;
                if (row.IdProduccion && !uniqueProductions.has(row.IdProduccion + '-' + row.Descrip_Maquina)) {
                    uniqueProductions.set(row.IdProduccion + '-' + row.Descrip_Maquina, { hsTrab: row.Hs_Trab });
                }
            });
            const totalPlannedMinutes = Array.from(uniqueProductions.values()).reduce((sum, item) => sum + item.hsTrab, 0);
            let productionMinutes = Math.max(0, totalPlannedMinutes - totalDowntimeMinutes);
            series[0].data.push(parseFloat((productionMinutes / 60).toFixed(1)));
            const downtimeTotals = {};
            dayDataRows.forEach(row => {
                if (row.descrip_incidencia) { downtimeTotals[row.descrip_incidencia] = (downtimeTotals[row.descrip_incidencia] || 0) + row.Minutos; }
            });
            allDowntimeReasons.forEach(reason => {
                const seriesIndex = reasonToIndexMap[reason];
                const minutes = downtimeTotals[reason] || 0;
                series[seriesIndex].data.push(parseFloat((minutes / 60).toFixed(1)));
            });
        });
        const numDays = sortedDays.length;
        series.forEach(s => { while (s.data.length < numDays) { s.data.push(0); } });
        return { series: series, categories: sortedDays.map(d => new Date(`${d}T00:00:00`).getTime()) };
    }

    return { aggregateDailyProduction, aggregateDailyTimeDistribution };
})();

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

    // Group all rows by production run to ensure data integrity
    const runsById = new Map();
    filteredData.forEach(row => {
        const prodId = row.IdProduccion;
        if (!prodId) return;
        const uniqueProdKey = `${prodId}-${row.Descrip_Maquina}`;
        if (!runsById.has(uniqueProdKey)) {
            runsById.set(uniqueProdKey, []);
        }
        runsById.get(uniqueProdKey).push(row);
    });
    const allRuns = Array.from(runsById.values());

    const chunks = [];
    const chunkSize = Math.ceil(allRuns.length / numWorkers);
    if (allRuns.length > 0 && chunkSize > 0) {
        for (let i = 0; i < allRuns.length; i += chunkSize) {
            chunks.push(allRuns.slice(i, i + chunkSize));
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
        if (workers[index]) { // Check if worker exists
            workers[index].postMessage({ 
                type: 'process_chunk', 
                payload: { 
                    jobId: jobId,
                    runGroups: chunk
                }
            });
        }
    });
}
