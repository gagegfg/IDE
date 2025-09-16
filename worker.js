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
    const { dateRange, selectedMachines, selectedShifts } = filters;
    
    return originalData.filter(row => {
        const rowDate = new Date(row.Fecha);
        const startDate = dateRange[0] ? new Date(dateRange[0]) : null;
        if(startDate) startDate.setHours(0,0,0,0);
        const endDate = dateRange[1] ? new Date(dateRange[1]) : null;
        if(endDate) endDate.setHours(23,59,59,999);

        const isDateInRange = dateRange.length === 2 ? rowDate >= startDate && rowDate <= endDate : true;
        const isMachineSelected = selectedMachines.length > 0 ? selectedMachines.includes(row.Descrip_Maquina) : true;
        const isShiftSelected = selectedShifts.length > 0 ? selectedShifts.includes(row.Turno) : true;
        return isDateInRange && isMachineSelected && isShiftSelected;
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
                shiftKey: `${new Date(row.Fecha).toISOString().split('T')[0]}-${row.Turno}`
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
    })).sort((a,b) => b.totalMinutes - a.totalMinutes);
}

function createSummaryData(kpiData, downtimeData) {
    if (!kpiData || downtimeData.length === 0) return { topReason: 'N/A' };
    const topReason = downtimeData[0].reason;
    const topReasonMins = downtimeData[0].totalMinutes;
    const totalDowntimeMins = kpiData.totalDowntimeHours * 60;
    const topReasonPercentage = totalDowntimeMins > 0 ? (topReasonMins / totalDowntimeMins * 100).toFixed(0) : 0;
    return {
        availabilityPercentage: (kpiData.availability * 100).toFixed(1),
        topReason,
        topReasonPercentage
    };
}

function aggregateDailyProduction(data, dateRange, isExtended) {
    const diffTime = dateRange[1] ? Math.abs(new Date(dateRange[1]) - new Date(dateRange[0])) : 0;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (isExtended && diffDays > 90) {
        return aggregateWeeklyProduction(data);
    }
    return aggregateDaily(data);
}

function aggregateDaily(data) {
    const aggregation = {};
    const seenProdIds = new Set();
    data.forEach(row => {
        if (row.Fecha) {
            const dateCategory = new Date(row.Fecha).toISOString().split('T')[0];
            const uniqueKey = `${dateCategory}-${row.IdProduccion}`;
            if (row.IdProduccion && !seenProdIds.has(uniqueKey)) {
                aggregation[dateCategory] = (aggregation[dateCategory] || 0) + row.Cantidad;
                seenProdIds.add(uniqueKey);
            }
        }
    });
    const sorted = Object.keys(aggregation).sort((a, b) => new Date(a) - new Date(b));
    return {
        series: [{ name: 'Producción Diaria', data: sorted.map(key => aggregation[key]) }],
        categories: sorted.map(key => new Date(key).getTime())
    };
}

function aggregateWeeklyProduction(data) {
    const aggregation = {};
    const seenProdIds = new Set();
    data.forEach(row => {
        if (row.Fecha) {
            const weekStartDate = getStartOfWeek(row.Fecha).toISOString().split('T')[0];
            const uniqueKey = `${weekStartDate}-${row.IdProduccion}`;
            if (row.IdProduccion && !seenProdIds.has(uniqueKey)) {
                aggregation[weekStartDate] = (aggregation[weekStartDate] || 0) + row.Cantidad;
                seenProdIds.add(uniqueKey);
            }
        }
    });
    const sorted = Object.keys(aggregation).sort((a, b) => new Date(a) - new Date(b));
    return {
        series: [{ name: 'Producción Semanal', data: sorted.map(key => aggregation[key]) }],
        categories: sorted.map(key => new Date(key).getTime())
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
            const dateString = new Date(row.Fecha).toISOString().split('T')[0];
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

function aggregateDailyTimeDistribution(data) {
    const timeByDay = {};
    const downtimeReasons = [...new Set(data.map(row => row.descrip_incidencia).filter(Boolean))];
    const dataByDay = data.reduce((acc, row) => {
        if (!row.Fecha) return acc;
        const day = new Date(row.Fecha).toISOString().split('T')[0];
        if (!acc[day]) acc[day] = [];
        acc[day].push(row);
        return acc;
    }, {});

    const sortedDays = Object.keys(dataByDay).sort();
    const series = downtimeReasons.map(reason => ({ name: reason, data: [] }));
    series.push({ name: 'Producción', data: [] });

    sortedDays.forEach(day => {
        const dayData = dataByDay[day];
        const uniqueProductions = new Map();
        dayData.forEach(row => {
            if (row.IdProduccion && !uniqueProductions.has(row.IdProduccion)) {
                uniqueProductions.set(row.IdProduccion, { hsTrab: row.Hs_Trab });
            }
        });

        const totalPlannedMinutes = Array.from(uniqueProductions.values()).reduce((sum, item) => sum + item.hsTrab, 0);
        const totalDowntimeMinutes = dayData.reduce((sum, row) => sum + row.Minutos, 0);
        let productionMinutes = totalPlannedMinutes - totalDowntimeMinutes;

        // Ensure productionMinutes is not negative
        productionMinutes = Math.max(0, productionMinutes);

        const downtimeTotals = downtimeReasons.reduce((acc, reason) => ({...acc, [reason]: 0}), {});

        dayData.forEach(row => {
            if (row.descrip_incidencia) {
                downtimeTotals[row.descrip_incidencia] += row.Minutos;
            }
        });

        series.forEach(s => {
            if (s.name === 'Producción') {
                s.data.push((productionMinutes / 60).toFixed(1));
            } else {
                s.data.push(((downtimeTotals[s.name] || 0) / 60).toFixed(1));
            }
        });
    });

    return {
        series: series,
        categories: sortedDays.map(d => new Date(d).toLocaleDateString('es-ES', {day: 'numeric', month: 'short'}))
    };
}


// --- MESSAGE HANDLER ---

self.onmessage = function(e) {
    const { type, payload } = e.data;

    if (type === 'load_data') {
        Papa.parse(payload.url, {
            download: true, header: true, delimiter: ';', skipEmptyLines: true,
            transformHeader: header => header.trim().replace(/[\s\W]+/g, '_'),
            complete: function(results) {
                originalData = processData(results.data);
                self.postMessage({
                    type: 'data_loaded',
                    payload: {
                        uniqueMachines: [...new Set(originalData.map(row => row.Descrip_Maquina))].filter(Boolean).sort(),
                        uniqueShifts: [...new Set(originalData.map(row => row.Turno))].filter(Boolean).sort()
                    }
                });
                // Also trigger the first dashboard update
                applyFiltersAndPost({ dateRange: [], selectedMachines: [], selectedShifts: [], isExtended: false });
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
    const { dateRange, isExtended } = filters;
    const filteredData = getFilteredData(filters);
    const kpiData = calculateKPIs(filteredData);
    const downtimeData = aggregateDowntime(filteredData);
    const summaryData = createSummaryData(kpiData, downtimeData);

    const chartsData = {
        dailyProdData: aggregateDailyProduction(filteredData, dateRange, isExtended),
        prodByMachineData: aggregateAndSort(filteredData, 'Descrip_Maquina', 'Cantidad', true),
        avgProdByOperatorData: calculateAverageProductionByShift(filteredData),
        downtimeComboData: downtimeData,
        dailyTimeData: aggregateDailyTimeDistribution(filteredData)
    };

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