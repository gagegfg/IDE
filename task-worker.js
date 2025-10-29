importScripts('https://cdn.jsdelivr.net/npm/papaparse@5.3.2/papaparse.min.js');

// --- UTILITY FUNCTIONS ---
function getLocalDateString(d) {
    const date = new Date(d);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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

function getStartOfWeek(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
    date.setHours(0, 0, 0, 0);
    return new Date(date.setDate(diff));
}

// --- CALCULATION FUNCTIONS ---

function calculateKPIs(data) {
    const productions = new Map();
    let totalDowntimeMinutes = 0;

    data.forEach(row => {
        totalDowntimeMinutes += row.Minutos || 0;
        
        const prodId = row.IdProduccion;
        const uniqueProdKey = `${prodId}-${row.Descrip_Maquina}`;

        if (prodId && !productions.has(uniqueProdKey)) {
            productions.set(uniqueProdKey, {
                cantidad: row.Cantidad || 0,
                hsTrab: row.Hs_Trab || 0
            });
        }
    });

    const productionValues = Array.from(productions.values());
    const totalProduction = productionValues.reduce((sum, p) => sum + p.cantidad, 0);
    const totalPlannedMinutes = productionValues.reduce((sum, p) => sum + p.hsTrab, 0);

    const runTimeMinutes = totalPlannedMinutes - totalDowntimeMinutes;
    const availability = totalPlannedMinutes > 0 ? Math.max(0, runTimeMinutes / totalPlannedMinutes) : 0;

    const numberOfProductionRuns = productions.size;
    const efficiency = numberOfProductionRuns > 0 ? totalProduction / numberOfProductionRuns : 0;

    return {
        totalProduction,
        totalDowntimeHours: totalDowntimeMinutes / 60,
        availability,
        efficiency,
        totalPlannedMinutes,
        numberOfProductionRuns // Ensure this is returned for aggregation
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

function aggregateDailyProduction(data, dateRange, isExtended, aggregationType) {
    if (!dateRange || dateRange.length < 2) return { series: [], categories: [] };
    
    const diffTime = Math.abs(new Date(dateRange[1]) - new Date(dateRange[0]));
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (isExtended && diffDays > 90) {
        return aggregateWeeklyProduction(data, dateRange);
    }
    return aggregateDaily(data, dateRange, aggregationType);
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

                if (!productionByShift.has(row.Turno)) {
                    productionByShift.set(row.Turno, new Map());
                }
                const shiftMap = productionByShift.get(row.Turno);
                if (!shiftMap.has(dateCategory)) {
                    shiftMap.set(dateCategory, 0);
                }

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

        const finalCategories = sortedDates
            .filter((_, index) => dateHasValue[index])
            .map(key => new Date(`${key}T00:00:00`).getTime());
            
        const filteredSeries = finalSeries.map(series => ({
            name: series.name,
            data: series.data.filter((_, index) => dateHasValue[index])
        }));

        return { series: filteredSeries, categories: finalCategories };

    } else {
        const aggregation = new Map();
        const seenProdIds = new Set();
        data.forEach(row => {
            if (row.Fecha) {
                const dateCategory = getLocalDateString(row.Fecha);
                if (!aggregation.has(dateCategory)) {
                    aggregation.set(dateCategory, 0);
                }

                const uniqueKey = `${dateCategory}-${row.IdProduccion}-${row.Descrip_Maquina}`;
                if (row.IdProduccion && !seenProdIds.has(uniqueKey)) {
                    aggregation.set(dateCategory, aggregation.get(dateCategory) + row.Cantidad);
                    seenProdIds.add(uniqueKey);
                }
            }
        });

        const finalEntries = [...aggregation.entries()].filter(([_, value]) => value > 0);
        finalEntries.sort((a, b) => a[0].localeCompare(b[0]));

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
            const uniqueKey = `${weekStartDate}-${row.IdProduccion}-${row.Descrip_Maquina}`;
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

function aggregateAndSort(data, categoryField, valueField) {
    const aggregation = new Map();
    const seenProdIds = new Set();
    data.forEach(row => {
        const category = row[categoryField];
        if (!category) return;
        const value = row[valueField] || 0;
        
        const uniqueKey = `${row.IdProduccion}-${row.Descrip_Maquina}`;
        if (row.IdProduccion && !seenProdIds.has(uniqueKey)) {
            aggregation.set(category, (aggregation.get(category) || 0) + value);
            seenProdIds.add(uniqueKey);
        }
    });
    let aggregatedArray = Array.from(aggregation.entries()).map(([key, val]) => ({ category: key, value: val }));
    return aggregatedArray.sort((a, b) => b.value - a.value);
}

function calculateAverageProductionByShift(data) {
    const operatorStats = {};

    data.forEach(row => {
        const operator = row.Apellido;
        if (!operator) return;

        if (!operatorStats[operator]) {
            // Use a map for productionRuns to correctly sum up production for each operator.
            operatorStats[operator] = { totalProduction: 0, productionRuns: new Set() };
        }
        
        const prodId = row.IdProduccion;
        const uniqueProdKey = `${prodId}-${row.Descrip_Maquina}`;

        if (prodId && !operatorStats[operator].productionRuns.has(uniqueProdKey)) {
            operatorStats[operator].totalProduction += row.Cantidad;
            operatorStats[operator].productionRuns.add(uniqueProdKey);
        }
    });

    // Return the components for each operator, not the final average.
    return Object.keys(operatorStats).map(operator => {
        const stats = operatorStats[operator];
        return { 
            category: operator, 
            totalProduction: stats.totalProduction,
            numberOfRuns: stats.productionRuns.size
        };
    });
}

function aggregateDailyTimeDistribution(data, dateRange) {
    if (!dateRange || dateRange.length < 2) return { series: [], categories: [] };

    const allDowntimeReasons = [...new Set(data.map(row => row.descrip_incidencia).filter(Boolean))];
    const dataByDay = new Map();
    const allDays = generateDateRange(dateRange[0], dateRange[1]);

    allDays.forEach(day => {
        const dayKey = getLocalDateString(day);
        dataByDay.set(dayKey, new Map());
    });

    data.forEach(row => {
        if (!row.Fecha) return;
        const dayKey = getLocalDateString(row.Fecha);
        if (dataByDay.has(dayKey)) {
            dataByDay.get(dayKey).set(row.IdProduccion + '-' + row.Descrip_Maquina, row);
        }
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
            if (row.descrip_incidencia) {
                downtimeTotals[row.descrip_incidencia] = (downtimeTotals[row.descrip_incidencia] || 0) + row.Minutos;
            }
        });

        allDowntimeReasons.forEach(reason => {
            const seriesIndex = reasonToIndexMap[reason];
            const minutes = downtimeTotals[reason] || 0;
            series[seriesIndex].data.push(parseFloat((minutes / 60).toFixed(1)));
        });
    });

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

    if (type === 'process_chunk') {
        const { jobId, dataChunk, dateRange, isExtended, dailyAggregationType } = payload;
        
        const kpiData = calculateKPIs(dataChunk);
        const downtimeData = aggregateDowntime(dataChunk);
        const dailyProdData = aggregateDailyProduction(dataChunk, dateRange, isExtended, dailyAggregationType);
        const prodByMachineData = aggregateAndSort(dataChunk, 'Descrip_Maquina', 'Cantidad');
        const avgProdByOperatorData = calculateAverageProductionByShift(dataChunk);
        const dailyTimeData = aggregateDailyTimeDistribution(dataChunk, dateRange);

        self.postMessage({
            type: 'chunk_processed',
            payload: { 
                jobId, // Echo the Job ID back
                kpiData, 
                downtimeData, 
                dailyProdData, 
                prodByMachineData, 
                avgProdByOperatorData, 
                dailyTimeData 
            }
        });
    }
};
