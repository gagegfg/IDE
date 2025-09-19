importScripts('https://cdn.jsdelivr.net/npm/papaparse@5.3.2/papaparse.min.js');

let originalData = [];

// --- UTILITY FUNCTIONS ---
function getStartOfWeek(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
    date.setHours(0, 0, 0, 0);
    return new Date(date.setDate(diff));
}

function getLocalDateString(d) {
    const date = new Date(d);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// --- DATA PROCESSING FUNCTIONS ---

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

function parseDate(dateString) {
    if (!dateString) return null;
    const parts = dateString.split('/');
    if (parts.length === 3) {
        const day = parseInt(parts[0], 10), month = parseInt(parts[1], 10) - 1, year = parseInt(parts[2], 10);
        if (!isNaN(day) && !isNaN(month) && !isNaN(year)) return new Date(year, month, day);
    }
    return null;
}

function getFilteredData(filters) {
    const { dateRange, selectedMachines, selectedShifts, selectedOperator } = filters;
    
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

        return isDateInRange && isMachineSelected && isShiftSelected && isOperatorSelected;
    });
}

function calculateKPIs(data) {
    const productions = new Map();
    let totalDowntimeMinutes = 0;

    data.forEach(row => {
        totalDowntimeMinutes += row.Minutos || 0;
        const prodId = row.IdProduccion;
        if (prodId && !productions.has(prodId)) {
            productions.set(prodId, {
                cantidad: row.Cantidad || 0,
                hsTrab: row.Hs_Trab || 0,
                shiftKey: `${getLocalDateString(row.Fecha)}-${row.Turno}`
            });
        }
    });

    const productionValues = Array.from(productions.values());
    const totalProduction = productionValues.reduce((sum, p) => sum + p.cantidad, 0);
    const plannedMinutes = productionValues.reduce((sum, p) => sum + p.hsTrab, 0);

    // Availability calculation
    const runTimeMinutes = plannedMinutes - totalDowntimeMinutes;
    const availability = plannedMinutes > 0 ? Math.max(0, runTimeMinutes / plannedMinutes) : 0;

    // Efficiency (Piezas por Turno) calculation
    const uniqueShifts = new Set(productionValues.map(p => p.shiftKey));
    const numberOfShifts = uniqueShifts.size;
    const efficiency = numberOfShifts > 0 ? totalProduction / numberOfShifts : 0;

    return {
        totalProduction,
        totalDowntimeHours: totalDowntimeMinutes / 60,
        availability,
        efficiency
    };
}

function aggregateDowntime(data) {
    const aggregation = {};
    data.forEach(row => {
        const reason = row.descrip_incidencia;
        if (!reason) return;
        if (!aggregation[reason]) {
            aggregation[reason] = { totalMinutes: 0, totalFrequency: 0 };
        }
        aggregation[reason].totalMinutes += row.Minutos || 0;
        aggregation[reason].totalFrequency += row.Frecuencia || 0;
    });
    return Object.keys(aggregation).map(reason => ({
        reason: reason,
        totalMinutes: aggregation[reason].totalMinutes,
        totalFrequency: aggregation[reason].totalFrequency
    }));
}

function createSummaryData(kpiData, downtimeData) {
    if (!kpiData || downtimeData.length === 0) return { topReason: 'N/A' };
    
    // Sort downtimeData by totalMinutes to find the top reason
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

function aggregateDailyProduction(data, dateRange, isExtended, aggregationType) {
    if (!dateRange || dateRange.length < 2) return { series: [], categories: [] };
    
    const diffTime = Math.abs(new Date(dateRange[1]) - new Date(dateRange[0]));
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (isExtended && diffDays > 90) {
        return aggregateWeeklyProduction(data, dateRange); // Weekly aggregation doesn't support byShift for now
    }
    return aggregateDaily(data, dateRange, aggregationType);
}

function aggregateDaily(data, dateRange, aggregationType = 'total') {
    if (aggregationType === 'byShift') {
        const productionByShift = new Map(); // Map<Shift, Map<Date, Production>>
        const allDates = new Set();
        const seenProdIds = new Set();

        data.forEach(row => {
            if (row.Fecha && row.Turno) {
                const dateCategory = getLocalDateString(row.Fecha);
                allDates.add(dateCategory);

                if (!productionByShift.has(row.Turno)) {
                    productionByShift.set(row.Turno, new Map());
                }
                const shiftMap = productionByShift.get(row.Turno);
                if (!shiftMap.has(dateCategory)) {
                    shiftMap.set(dateCategory, 0);
                }

                const uniqueKey = `${dateCategory}-${row.Turno}-${row.IdProduccion}`;
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
        
        const dateHasValue = sortedDates.map((_, dateIndex) => {
            return finalSeries.some(series => series.data[dateIndex] !== null);
        });

        const finalCategories = sortedDates
            .filter((_, index) => dateHasValue[index])
            .map(key => new Date(`${key}T00:00:00`).getTime());
            
        const filteredSeries = finalSeries.map(series => {
            return {
                name: series.name,
                data: series.data.filter((_, index) => dateHasValue[index])
            };
        });

        return { series: filteredSeries, categories: finalCategories };

    } else { // 'total' aggregation
        const aggregation = new Map();
        const seenProdIds = new Set();
        data.forEach(row => {
            if (row.Fecha) {
                const dateCategory = getLocalDateString(row.Fecha);
                if (!aggregation.has(dateCategory)) {
                    aggregation.set(dateCategory, 0);
                }

                const uniqueKey = `${dateCategory}-${row.IdProduccion}`;
                if (row.IdProduccion && !seenProdIds.has(uniqueKey)) {
                    aggregation.set(dateCategory, aggregation.get(dateCategory) + row.Cantidad);
                    seenProdIds.add(uniqueKey);
                }
            }
        });

        const finalEntries = [...aggregation.entries()].filter(([_, value]) => value > 0);
        finalEntries.sort((a, b) => a[0].localeCompare(b[0])); // Sort by date

        return {
            series: [{ name: 'Producción Diaria', data: finalEntries.map(entry => entry[1]) }],
            categories: finalEntries.map(entry => new Date(`${entry[0]}T00:00:00`).getTime())
        };
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
            const uniqueKey = `${weekStartDate}-${row.IdProduccion}`;
            if (row.IdProduccion && !seenProdIds.has(uniqueKey)) {
                if(aggregation.has(weekStartDate)){
                    aggregation.set(weekStartDate, aggregation.get(weekStartDate) + row.Cantidad);
                }
                seenProdIds.add(uniqueKey);
            }
        }
    });
    
    const sortedCategories = [...aggregation.keys()].sort();
    const seriesData = sortedCategories.map(key => aggregation.get(key));

    return {
        series: [{ name: 'Producción Semanal', data: seriesData }],
        categories: sortedCategories.map(key => new Date(`${key}T00:00:00`).getTime())
    };
}

function aggregateAndSort(data, categoryField, valueField, uniqueByIdProd = false) {
    const aggregation = {}; const seenIds = new Set();
    data.forEach(row => {
        const category = row[categoryField];
        if (!category) return;
        const value = row[valueField] || 0;
        if (uniqueByIdProd) {
            const uniqueKey = `${row.IdProduccion}-${category}`;
            if (row.IdProduccion && !seenIds.has(uniqueKey)) { 
                aggregation[category] = (aggregation[category] || 0) + value; 
                seenIds.add(uniqueKey); 
            }
        } else { 
            aggregation[category] = (aggregation[category] || 0) + value; 
        }
    });
    let aggregatedArray = Object.keys(aggregation).map(key => ({ category: key, value: aggregation[key] }));
    return aggregatedArray.sort((a, b) => b.value - a.value);
}

function calculateAverageProductionByShift(data) {
    const operatorStats = {};
    const seenProdIds = new Set();

    data.forEach(row => {
        const operator = row.Apellido;
        if (!operator) return;

        if (!operatorStats[operator]) {
            operatorStats[operator] = { totalProduction: 0, shifts: new Set() };
        }

        const uniqueProdKey = `${row.IdProduccion}-${operator}`;
        if (row.IdProduccion && !seenProdIds.has(uniqueProdKey)) {
            operatorStats[operator].totalProduction += row.Cantidad;
            seenProdIds.add(uniqueProdKey);
        }
        
        if (row.Turno && row.Fecha) {
            const dateString = getLocalDateString(row.Fecha);
            operatorStats[operator].shifts.add(`${dateString};${row.Turno}`);
        }
    });

    const result = Object.keys(operatorStats).map(operator => {
        const stats = operatorStats[operator];
        const shiftCount = stats.shifts.size;
        const average = shiftCount > 0 ? stats.totalProduction / shiftCount : 0;
        return { category: operator, value: average };
    });
    
    return result.sort((a, b) => b.value - a.value);
}

function aggregateDailyTimeDistribution(data, dateRange) {
    if (!dateRange || dateRange.length < 2) return { series: [], categories: [] };

    const allDowntimeReasons = [...new Set(data.map(row => row.descrip_incidencia).filter(Boolean))];
    const dataByDay = new Map();
    const allDays = generateDateRange(dateRange[0], dateRange[1]);

    allDays.forEach(day => {
        const dayKey = getLocalDateString(day);
        dataByDay.set(dayKey, []);
    });

    data.forEach(row => {
        if (!row.Fecha) return;
        const dayKey = getLocalDateString(row.Fecha);
        if (dataByDay.has(dayKey)) {
            dataByDay.get(dayKey).push(row);
        }
    });

    const sortedDays = [...dataByDay.keys()].sort();

    const series = [{ name: 'Producción', data: [] }];
    allDowntimeReasons.forEach(reason => {
        series.push({ name: reason, data: [] });
    });
    const reasonToIndexMap = allDowntimeReasons.reduce((acc, reason, index) => {
        acc[reason] = index + 1; // +1 because 'Producción' is at index 0
        return acc;
    }, {});

    sortedDays.forEach(day => {
        const dayData = dataByDay.get(day);
        const uniqueProductions = new Map();
        dayData.forEach(row => {
            if (row.IdProduccion && !uniqueProductions.has(row.IdProduccion)) {
                uniqueProductions.set(row.IdProduccion, { hsTrab: row.Hs_Trab });
            }
        });

        const totalPlannedMinutes = Array.from(uniqueProductions.values()).reduce((sum, item) => sum + item.hsTrab, 0);
        const totalDowntimeMinutes = dayData.reduce((sum, row) => sum + row.Minutos, 0);
        let productionMinutes = Math.max(0, totalPlannedMinutes - totalDowntimeMinutes);

        series[0].data.push(parseFloat((productionMinutes / 60).toFixed(1)));

        const downtimeTotals = {};
        dayData.forEach(row => {
            if (row.descrip_incidencia) {
                downtimeTotals[row.descrip_incidencia] = (downtimeTotals[row.descrip_incidencia] || 0) + row.Minutos;
            }
        });

        allDowntimeReasons.forEach(reason => {
            const seriesIndex = reasonToIndexMap[reason];
            const minutes = downtimeTotals[reason] || 0;
            // Ensure data array exists before pushing
            if (!series[seriesIndex].data) {
                series[seriesIndex].data = [];
            }
            series[seriesIndex].data.push(parseFloat((minutes / 60).toFixed(1)));
        });
    });

    // Ensure all series have the same length, filling with 0 for days without specific downtime
    const numDays = sortedDays.length;
    series.forEach(s => {
        while (s.data.length < numDays) {
            s.data.push(0);
        }
    });

    return {
        series: series,
        categories: sortedDays.map(d => new Date(`${d}T00:00:00`).getTime())
    };
}


// --- MESSAGE HANDLER ---

self.onmessage = function(e) {
    const { type, payload } = e.data;

    if (type === 'load_data') {
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
                        uniqueShifts: [...new Set(originalData.map(row => row.Turno))].filter(Boolean).sort()
                    }
                });
                // Also trigger the first dashboard update
                applyFiltersAndPost({ dateRange: [startOfPreviousMonth, today], selectedMachines: [], selectedShifts: [], isExtended: false, dailyAggregationType: 'total' });
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
    const { dateRange, isExtended, dailyAggregationType } = filters;
    self.postMessage({ type: 'progress', payload: { progress: 5, status: 'Filtrando datos...' } });
    const filteredData = getFilteredData(filters);

    self.postMessage({ type: 'progress', payload: { progress: 20, status: 'Calculando KPIs...' } });
    const kpiData = calculateKPIs(filteredData);

    self.postMessage({ type: 'progress', payload: { progress: 40, status: 'Agregando paradas...' } });
    const downtimeData = aggregateDowntime(filteredData);

    self.postMessage({ type: 'progress', payload: { progress: 50, status: 'Creando resumen...' } });
    const summaryData = createSummaryData(kpiData, downtimeData);

    self.postMessage({ type: 'progress', payload: { progress: 60, status: 'Generando gráficos...' } });
    const chartsData = {
        dailyProdData: aggregateDailyProduction(filteredData, dateRange, isExtended, dailyAggregationType),
        prodByMachineData: aggregateAndSort(filteredData, 'Descrip_Maquina', 'Cantidad', true),
        avgProdByOperatorData: calculateAverageProductionByShift(filteredData),
        downtimeComboData: downtimeData,
        dailyTimeData: aggregateDailyTimeDistribution(filteredData, dateRange)
    };

    self.postMessage({ type: 'progress', payload: { progress: 95, status: 'Finalizando...' } });

    self.postMessage({
        type: 'update_dashboard',
        payload: { 
            filteredData, // For modals
            kpiData, 
            chartsData, 
            summaryData 
        }
    });
}
