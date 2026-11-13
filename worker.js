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

function getLocalDateString(d) {
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(d);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function inferMachineGroup(row) {
    const existing = (row.Grupo_Maquina || '').trim();
    if (existing) return existing;
    const desc = (row.Descrip_Maquina || '').trim().toUpperCase();
    if (desc.includes('BUDINERA')) return 'BUDINERA';
    if (desc === 'PAN DULCERA 11' || desc.includes('MANUAL')) return 'PANDULCERA MANUAL';
    if (desc.includes('PAN DULCERA') || desc.includes('PANDULCERA')) return 'PANDULCERA';
    return '';
}

function processData(data) {
    const processed = [];
    for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const fecha = parseDate(row.Fecha);
        if (!(fecha instanceof Date) || isNaN(fecha)) continue;

        row.Fecha = fecha;
        row.dateStr = getLocalDateString(fecha);
        row.timestamp = fecha.getTime();
        row.Descrip_Maquina = (row.Descrip_Maquina || '').trim();
        row.Turno = (row.Turno || '').trim();
        row.Apellido = (row.Apellido || '').trim();
        row.descrip_incidencia = (row.descrip_incidencia || '').trim();
        row.Grupo_Maquina = inferMachineGroup(row);
        row.Cantidad = parseInt(row.Cantidad, 10) || 0;
        row.Minutos = parseInt(row.Minutos, 10) || 0;
        row.Frecuencia = parseInt(row.Frecuencia, 10) || 0;
        row.Hs_Trab = parseFloat(String(row.Hs_Trab).replace(',', '.')) || 0;
        row.Objetivo = parseInt(row.Objetivo, 10) || 0;
        processed.push(row);
    }
    return processed;
}

function getFilteredData(filters) {
    const {
        dateMode = 'range',
        dateRange = [],
        selectedDatesStr = [],
        selectedMachines = [],
        selectedShifts = [],
        selectedOperator = null,
        selectedMachineGroup = null,
        selectedMachineGroups = []
    } = filters;

    // Pre-build Sets and timestamps for O(1) filtering per row
    const datesSet = (dateMode === 'multiple' || dateMode === 'single') && selectedDatesStr.length > 0
        ? new Set(selectedDatesStr)
        : null;

    let startTs = null;
    let endTs = null;
    if (dateMode === 'range' && dateRange && dateRange.length > 0) {
        const d0 = new Date(dateRange[0]);
        d0.setHours(0, 0, 0, 0);
        startTs = d0.getTime();
        const d1 = new Date(dateRange.length >= 2 ? dateRange[1] : dateRange[0]);
        d1.setHours(23, 59, 59, 999);
        endTs = d1.getTime();
    }

    const machinesSet = selectedMachines && selectedMachines.length > 0 ? new Set(selectedMachines) : null;
    const shiftsSet = selectedShifts && selectedShifts.length > 0 ? new Set(selectedShifts) : null;

    const activeGroups = selectedMachineGroups && selectedMachineGroups.length > 0
        ? new Set(selectedMachineGroups)
        : (selectedMachineGroup ? new Set([selectedMachineGroup]) : null);

    return originalData.filter(row => {
        // 1. Date check
        if (datesSet) {
            if (!datesSet.has(row.dateStr)) return false;
        } else if (startTs !== null && endTs !== null) {
            if (row.timestamp < startTs || row.timestamp > endTs) return false;
        }

        // 2. Machine Group check
        if (activeGroups && !activeGroups.has(row.Grupo_Maquina)) return false;

        // 3. Machine check
        if (machinesSet && !machinesSet.has(row.Descrip_Maquina)) return false;

        // 4. Shift check
        if (shiftsSet && !shiftsSet.has(row.Turno)) return false;

        // 5. Operator check
        if (selectedOperator && row.Apellido !== selectedOperator) return false;

        return true;
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
        const emptyKpi = {
            totalProduction: 0,
            totalDowntimeHours: 0,
            totalDowntimeFrequency: 0,
            totalNetProductionHours: 0,
            totalPlannedHours: 0,
            availability: 0,
            efficiency: 0,
            totalRuns: 0,
            activeDays: 0,
            dailyAverage: 0
        };
        const emptyCharts = {
            dailyProdData: { series: [], categories: [], dateStrings: [] },
            prodByMachineData: [],
            avgProdByOperatorData: [],
            downtimeComboData: [],
            dailyTimeData: { series: [], categories: [] },
            machineSummaryData: []
        };
        self.postMessage({
            type: 'update_dashboard',
            payload: {
                filteredData,
                kpiData: emptyKpi,
                chartsData: emptyCharts,
                summaryData: { topReason: 'N/A' }
            }
        });
        return;
    }

    // --- Aggregate KPIs from partial results ---
    const totalProduction = results.reduce((sum, res) => sum + res.kpiData.totalProduction, 0);
    const totalDowntimeMinutes = results.reduce((sum, res) => sum + res.kpiData.totalDowntimeMinutes, 0);
    const totalDowntimeHours = totalDowntimeMinutes / 60;
    const totalDowntimeFrequency = results.reduce((sum, res) => sum + (res.kpiData.totalDowntimeFrequency || 0), 0);
    const totalNetProductionMinutes = results.reduce((sum, res) => sum + res.kpiData.totalNetProductionMinutes, 0);
    const totalPlannedMinutes = totalNetProductionMinutes + totalDowntimeMinutes;
    const totalRuns = results.reduce((sum, res) => sum + res.kpiData.numberOfProductionRuns, 0);

    const availability = totalPlannedMinutes > 0 ? Math.max(0, totalNetProductionMinutes / totalPlannedMinutes) : 0;
    const efficiency = totalRuns > 0 ? totalProduction / totalRuns : 0;

    // --- Aggregate Chart Data from partial results ---
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
        return { category: operator, value: average, runs: data.numberOfRuns, total: data.totalProduction };
    }).sort((a, b) => b.value - a.value);

    const machineDataMap = new Map();
    results.flatMap(r => r.prodByMachineData).forEach(mData => {
        machineDataMap.set(mData.category, (machineDataMap.get(mData.category) || 0) + mData.value);
    });
    const finalProdByMachine = Array.from(machineDataMap.entries())
        .map(([category, value]) => ({ category, value }))
        .sort((a, b) => b.value - a.value);

    // --- Aggregate Machine Summary Table Data ---
    const machineSummaryMap = new Map();
    results.flatMap(r => r.machineSummaryData || []).forEach(m => {
        let entry = machineSummaryMap.get(m.machine);
        if (!entry) {
            entry = {
                machine: m.machine,
                group: m.group,
                runs: 0,
                production: 0,
                netMinutes: 0,
                downtimeMinutes: 0,
                downtimeEvents: 0,
                reasons: {}
            };
            machineSummaryMap.set(m.machine, entry);
        }
        entry.runs += m.runs;
        entry.production += m.production;
        entry.netMinutes += m.netMinutes;
        entry.downtimeMinutes += m.downtimeMinutes;
        entry.downtimeEvents += m.downtimeEvents;
        for (const [rKey, rMins] of Object.entries(m.reasons)) {
            entry.reasons[rKey] = (entry.reasons[rKey] || 0) + rMins;
        }
    });

    const finalMachineSummary = Array.from(machineSummaryMap.values()).map(m => {
        const planned = m.netMinutes + m.downtimeMinutes;
        const avail = planned > 0 ? (m.netMinutes / planned) * 100 : 0;
        const avgPerShift = m.runs > 0 ? m.production / m.runs : 0;
        let topReason = 'Sin paradas';
        let topReasonMins = 0;
        for (const [rKey, rMins] of Object.entries(m.reasons)) {
            if (rMins > topReasonMins) {
                topReasonMins = rMins;
                topReason = rKey;
            }
        }
        return {
            machine: m.machine,
            group: m.group,
            runs: m.runs,
            production: m.production,
            avgPerShift: Math.round(avgPerShift),
            netHours: parseFloat((m.netMinutes / 60).toFixed(1)),
            downtimeHours: parseFloat((m.downtimeMinutes / 60).toFixed(1)),
            downtimeEvents: m.downtimeEvents,
            availability: parseFloat(avail.toFixed(1)),
            topReason,
            topReasonHours: parseFloat((topReasonMins / 60).toFixed(1))
        };
    }).sort((a, b) => b.production - a.production);

    // --- Reduce and format daily chart data ---
    const dailyProdData = formatDailyProduction(results.map(r => r.dailyProdAggregation), filters.dailyAggregationType);
    const dailyTimeData = formatDailyTimeDistribution(results.map(r => r.dailyTimeAggregation));

    const activeDays = dailyProdData.dateStrings ? dailyProdData.dateStrings.length : 0;
    const dailyAverage = activeDays > 0 ? totalProduction / activeDays : 0;

    const finalKpiData = {
        totalProduction,
        totalDowntimeHours,
        totalDowntimeFrequency,
        totalNetProductionHours: totalNetProductionMinutes / 60,
        totalPlannedHours: totalPlannedMinutes / 60,
        availability,
        efficiency,
        totalRuns,
        activeDays,
        dailyAverage
    };

    const summaryData = createSummaryData(finalKpiData, finalDowntimeData, finalMachineSummary);

    const finalChartsData = {
        dailyProdData,
        prodByMachineData: finalProdByMachine,
        avgProdByOperatorData: finalAvgProdByOperator,
        downtimeComboData: finalDowntimeData,
        dailyTimeData,
        machineSummaryData: finalMachineSummary
    };

    self.postMessage({ type: 'progress', payload: { progress: 95, status: 'Finalizando...' } });
    self.postMessage({ type: 'update_dashboard', payload: { filteredData, kpiData: finalKpiData, chartsData: finalChartsData, summaryData } });
}

function createSummaryData(kpiData, downtimeData, machineSummary) {
    if (!kpiData || kpiData.totalRuns === 0) return { topReason: 'N/A' };
    const sortedDowntime = [...downtimeData].sort((a, b) => b.totalMinutes - a.totalMinutes);
    const topReason = sortedDowntime[0]?.reason || 'Sin paradas';
    const topReasonMins = sortedDowntime[0]?.totalMinutes || 0;
    const totalDowntimeMins = kpiData.totalDowntimeHours * 60;
    const topReasonPercentage = totalDowntimeMins > 0 ? (topReasonMins / totalDowntimeMins * 100).toFixed(0) : 0;
    const topReasonHours = (topReasonMins / 60).toFixed(1);

    const topMachine = machineSummary[0]?.machine || 'N/A';
    const topMachineProd = machineSummary[0]?.production || 0;

    const sortedByDowntime = [...machineSummary].sort((a, b) => b.downtimeHours - a.downtimeHours);
    const worstDowntimeMachine = sortedByDowntime[0]?.machine || 'N/A';
    const worstDowntimeHours = sortedByDowntime[0]?.downtimeHours || 0;

    return {
        availabilityPercentage: (kpiData.availability * 100).toFixed(1),
        topReason,
        topReasonPercentage,
        topReasonHours,
        topMachine,
        topMachineProd,
        worstDowntimeMachine,
        worstDowntimeHours
    };
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
        const seriesData = sortedDates.map(date => {
            const value = finalDailyProd.get(date);
            return value > 0 ? value : null;
        });
        series.push({ name: 'Producción Total', data: seriesData });
    } else {
        const allGroupKeys = new Set();
        finalDailyProd.forEach(groupMap => {
            groupMap.forEach((_, key) => allGroupKeys.add(key));
        });
        const sortedGroupKeys = Array.from(allGroupKeys).sort();

        series = sortedGroupKeys.map(key => ({
            name: key,
            data: sortedDates.map(date => {
                const dayMap = finalDailyProd.get(date);
                const value = dayMap ? dayMap.get(key) : undefined;
                return value > 0 ? value : null;
            })
        }));
    }

    return { series, categories, dateStrings: sortedDates };
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

    const series = [{ name: 'Producción Neta', data: [] }];
    sortedReasons.forEach(reason => series.push({ name: reason, data: [] }));

    const reasonToIndexMap = sortedReasons.reduce((acc, reason, index) => {
        acc[reason] = index + 1;
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
        categories: sortedDates.map(date => new Date(`${date}T00:00:00`).getTime()),
        dateStrings: sortedDates
    };
}

// --- MESSAGE HANDLER ---

setupWorkers();

self.onmessage = function (e) {
    const { type, payload } = e.data;

    if (type === 'load_data') {
        self.postMessage({ type: 'progress', payload: { progress: 0, status: 'Cargando datos CSV...' } });
        Papa.parse(payload.url, {
            download: true,
            header: true,
            delimiter: ';',
            skipEmptyLines: true,
            transformHeader: header => header.trim().replace(/[\W]+/g, '_'),
            complete: function (results) {
                originalData = processData(results.data);

                const machineToGroupMap = {};
                let minTs = Infinity;
                let maxTs = -Infinity;
                let minDateStr = null;
                let maxDateStr = null;

                for (let i = 0; i < originalData.length; i++) {
                    const r = originalData[i];
                    if (r.Descrip_Maquina && r.Grupo_Maquina) {
                        machineToGroupMap[r.Descrip_Maquina] = r.Grupo_Maquina;
                    }
                    if (r.timestamp < minTs) {
                        minTs = r.timestamp;
                        minDateStr = r.dateStr;
                    }
                    if (r.timestamp > maxTs) {
                        maxTs = r.timestamp;
                        maxDateStr = r.dateStr;
                    }
                }

                const uniqueMachines = [...new Set(originalData.map(row => row.Descrip_Maquina))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
                const uniqueShifts = [...new Set(originalData.map(row => row.Turno))].filter(Boolean).sort();
                const uniqueMachineGroups = [...new Set(originalData.map(row => row.Grupo_Maquina))].filter(Boolean).sort();
                const uniqueOperators = [...new Set(originalData.map(row => row.Apellido))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'es'));

                self.postMessage({
                    type: 'data_loaded',
                    payload: {
                        uniqueMachines,
                        uniqueShifts,
                        uniqueMachineGroups,
                        uniqueOperators,
                        machineToGroupMap,
                        minDateStr,
                        maxDateStr,
                        totalRecords: originalData.length
                    }
                });
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

    // Group by IdProduccion so no production run is ever split across workers
    const groupedByProductionId = new Map();
    for (let i = 0; i < filteredData.length; i++) {
        const row = filteredData[i];
        if (!row.IdProduccion) continue;
        let group = groupedByProductionId.get(row.IdProduccion);
        if (!group) {
            group = [];
            groupedByProductionId.set(row.IdProduccion, group);
        }
        group.push(row);
    }

    const productionGroups = Array.from(groupedByProductionId.values());
    const chunks = Array.from({ length: numWorkers }, () => []);
    productionGroups.forEach((group, index) => {
        chunks[index % numWorkers].push(...group);
    });

    const jobId = nextJobId++;
    const activeChunks = chunks.filter(c => c.length > 0);
    jobs.set(jobId, {
        results: [],
        workersFinished: 0,
        totalChunks: activeChunks.length,
        filters: filters,
        filteredData: filteredData
    });

    if (activeChunks.length === 0) {
        aggregateResults([], filteredData, filters);
        jobs.delete(jobId);
        return;
    }

    self.postMessage({ type: 'progress', payload: { progress: 15, status: `Procesando en ${activeChunks.length} núcleos...` } });

    chunks.forEach((chunk, index) => {
        if (chunk.length > 0 && workers[index]) {
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
