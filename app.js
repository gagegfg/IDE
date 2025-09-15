document.addEventListener('DOMContentLoaded', function () {
    const CSV_URL = 'exportProduccionyEventos.csv';
    const API_KEY = 'AIzaSyAYLOGw5vncaz1jN3uTsRvup3WeS1MBgQI'; // ¡¡¡REEMPLAZAR CON TU API KEY!!!
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${API_KEY}`;

    let originalData = [];
    let charts = {};
    let choicesMachine, choicesShift, datepicker;
    let detailModal;

    const loadingOverlay = document.getElementById('loading-overlay');
    const themeToggle = document.getElementById('theme-toggle');
    const chartColors = ['#5E35B1', '#039BE5', '#00897B', '#FDD835', '#E53935', '#8E24AA', '#3949AB'];

    const aiAssistantBtn = document.getElementById('ai-assistant-btn');
    const chatContainer = document.getElementById('ai-chat-container');
    const closeChatBtn = document.getElementById('close-chat-btn');
    const chatInput = document.getElementById('chat-input');
    const sendChatBtn = document.getElementById('send-chat-btn');
    const chatBody = document.getElementById('chat-body');

    const formatNumber = (val) => val ? val.toLocaleString('es-ES', { maximumFractionDigits: 0 }) : val;

    function applyTheme(theme) {
        document.body.setAttribute('data-theme', theme);
        themeToggle.checked = theme === 'dark';
        Object.values(charts).forEach(chart => {
            if (chart.chart) {
                chart.updateOptions({ theme: { mode: theme }, chart: { background: 'transparent' } });
            }
        });
    }

    function initTheme() {
        const savedTheme = localStorage.getItem('dashboardTheme') || 'light';
        applyTheme(savedTheme);
        themeToggle.addEventListener('change', () => {
            const newTheme = themeToggle.checked ? 'dark' : 'light';
            localStorage.setItem('dashboardTheme', newTheme);
            applyTheme(newTheme);
        });
    }

    function toggleLoading(show) {
        loadingOverlay.style.display = show ? 'flex' : 'none';
    }

    function init() {
        initTheme();
        initAIChat();
        detailModal = new bootstrap.Modal(document.getElementById('detailModal'));
        toggleLoading(true);
        Papa.parse(CSV_URL, {
            download: true, header: true, delimiter: ';', skipEmptyLines: true,
            transformHeader: header => header.trim().replace(/[\s\W]+/g, '_'),
            complete: function(results) {
                originalData = processData(results.data);
                populateFilters(originalData);
                addEventListeners();
                
                const today = new Date();
                const startOfPreviousMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                datepicker.setDate([startOfPreviousMonth, today], true);
                
                document.getElementById('last-updated').textContent = `Actualizado: ${new Date().toLocaleString('es-ES')}`;
            },
            error: err => {
                console.error("Error al cargar o parsear el CSV:", err);
                alert("No se pudo cargar el archivo de datos. Revisa la consola para más detalles.");
                toggleLoading(false);
            }
        });
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

    function parseDate(dateString) {
        if (!dateString) return null;
        const parts = dateString.split('/');
        if (parts.length === 3) {
            const day = parseInt(parts[0], 10), month = parseInt(parts[1], 10) - 1, year = parseInt(parts[2], 10);
            if (!isNaN(day) && !isNaN(month) && !isNaN(year)) return new Date(year, month, day);
        }
        return null;
    }

    function populateFilters(data) {
        const uniqueMachines = [...new Set(data.map(row => row.Descrip_Maquina))].filter(Boolean).sort();
        const uniqueShifts = [...new Set(data.map(row => row.Turno))].filter(Boolean).sort();
        const machineFilterEl = document.getElementById('machine-filter');
        uniqueMachines.forEach(machine => machineFilterEl.add(new Option(machine, machine)));
        const shiftFilterEl = document.getElementById('shift-filter');
        uniqueShifts.forEach(shift => shiftFilterEl.add(new Option(shift, shift)));
        choicesMachine = new Choices(machineFilterEl, { removeItemButton: true, placeholder: true, placeholderValue: 'Todas las máquinas...' });
        choicesShift = new Choices(shiftFilterEl, { removeItemButton: true, placeholder: true, placeholderValue: 'Todos los turnos...' });
    }

    function addEventListeners() {
        datepicker = flatpickr("#date-range-picker", { mode: "range", dateFormat: "d/m/Y", locale: "es", onChange: () => applyFilters() });
        document.getElementById('machine-filter').addEventListener('change', applyFilters);
        document.getElementById('shift-filter').addEventListener('change', applyFilters);
        
        const today = new Date();
        
        document.getElementById('btnMesActual').addEventListener('click', () => datepicker.setDate([new Date(today.getFullYear(), today.getMonth(), 1), today], true));
        document.getElementById('btnMesAnterior').addEventListener('click', () => {
             const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
             const end = new Date(today.getFullYear(), today.getMonth(), 0);
             datepicker.setDate([start, end], true);
        });
        
        document.getElementById('btnSemanaActual').addEventListener('click', () => {
            const first = today.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1);
            const startOfWeek = new Date(new Date().setDate(first));
            datepicker.setDate([startOfWeek, new Date()], true);
        });
         document.getElementById('btnSemanaAnterior').addEventListener('click', () => {
            const before = new Date();
            before.setDate(before.getDate() - 7);
            const first = before.getDate() - before.getDay() + (before.getDay() === 0 ? -6 : 1);
            const startOfLastWeek = new Date(new Date().setDate(first));
            const endOfLastWeek = new Date(startOfLastWeek);
            endOfLastWeek.setDate(endOfLastWeek.getDate() + 6);
            datepicker.setDate([startOfLastWeek, endOfLastWeek], true);
        });

        document.getElementById('reset-filters').addEventListener('click', () => {
            const today = new Date();
            const startOfPreviousMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            datepicker.setDate([startOfPreviousMonth, today], true);
            choicesMachine.removeActiveItems();
            choicesShift.removeActiveItems();
        });
    }

    function applyFilters() {
        toggleLoading(true);
        setTimeout(() => {
            const filteredData = getFilteredData();
            updateDashboard(filteredData);
        }, 50);
    }

    function getFilteredData() {
        const dateRange = datepicker.selectedDates;
        const selectedMachines = choicesMachine.getValue(true);
        const selectedShifts = choicesShift.getValue(true);
        
        return originalData.filter(row => {
            const rowDate = row.Fecha;
            const startDate = dateRange[0] ? new Date(dateRange[0].setHours(0,0,0,0)) : null;
            const endDate = dateRange[1] ? new Date(dateRange[1].setHours(23,59,59,999)) : null;
            const isDateInRange = dateRange.length === 2 ? rowDate >= startDate && rowDate <= endDate : true;
            const isMachineSelected = selectedMachines.length > 0 ? selectedMachines.includes(row.Descrip_Maquina) : true;
            const isShiftSelected = selectedShifts.length > 0 ? selectedShifts.includes(row.Turno) : true;
            return isDateInRange && isMachineSelected && isShiftSelected;
        });
    }
    
    function updateDashboard(data) {
        const kpiData = calculateKPIs(data);
        renderKPIs(kpiData);
        updateCharts(data);
        updateSummary(data, kpiData);
        toggleLoading(false);
    }

    function calculateKPIs(data) {
        const uniqueProductions = new Map();
        data.forEach(row => {
            if (row.IdProduccion && !uniqueProductions.has(row.IdProduccion)) {
                uniqueProductions.set(row.IdProduccion, { 
                    cantidad: row.Cantidad, 
                    hsTrab: row.Hs_Trab,
                    objetivo: row.Objetivo
                });
            }
        });
        
        const productionValues = Array.from(uniqueProductions.values());
        const totalProduction = productionValues.reduce((sum, item) => sum + item.cantidad, 0);
        const totalTarget = productionValues.reduce((sum, item) => sum + item.objetivo, 0);
        const plannedMinutes = productionValues.reduce((sum, item) => sum + item.hsTrab, 0);
        const totalDowntimeMinutes = data.reduce((sum, row) => sum + row.Minutos, 0);
        const runTimeMinutes = plannedMinutes - totalDowntimeMinutes;

        const availability = plannedMinutes > 0 ? (runTimeMinutes / plannedMinutes) : 0;
        const efficiency = runTimeMinutes > 0 ? totalProduction / (runTimeMinutes / 60) : 0;

        return {
            totalProduction,
            totalDowntimeHours: totalDowntimeMinutes / 60,
            availability: Math.max(0, availability),
            efficiency
        };
    }

    function renderKPIs(kpiData) {
        document.getElementById('kpi-total-production').textContent = formatNumber(kpiData.totalProduction);
        document.getElementById('kpi-availability').textContent = `${(kpiData.availability * 100).toFixed(1)}%`;
        
        document.getElementById('kpi-efficiency').textContent = formatNumber(kpiData.efficiency);
        document.getElementById('kpi-total-downtime').textContent = kpiData.totalDowntimeHours.toFixed(1);
    }
    
    function updateSummary(data, kpiData) {
        if (data.length === 0) {
            document.getElementById('summary-text').textContent = "No hay datos para el período o filtros seleccionados."; return;
        }
        const downtimeByReason = aggregateDowntime(data).sort((a,b) => b.totalMinutes - a.totalMinutes);
        const topReason = downtimeByReason[0] ? downtimeByReason[0].reason : "N/A";
        const topReasonMins = downtimeByReason[0] ? downtimeByReason[0].totalMinutes : 0;
        const totalDowntimeMins = kpiData.totalDowntimeHours * 60;
        const topReasonPercentage = totalDowntimeMins > 0 ? (topReasonMins / totalDowntimeMins * 100).toFixed(0) : 0;
        const summary = `El KPI de <strong>Disponibilidad</strong> se sitúa en un <strong>${(kpiData.availability * 100).toFixed(1)}%</strong>. La principal causa de inactividad es <strong>\"${topReason}\"</strong>, responsable del <strong>${topReasonPercentage}%</strong> del tiempo total de parada.`;
        document.getElementById('summary-text').innerHTML = summary;
    }

    function showDrillDownModal(category, type = 'machine') {
        const dateRange = datepicker.selectedDates;
        const startDate = dateRange[0];
        const endDate = dateRange[1];

        let detailData, modalTitleText, tableHeader, tableBody = '';

        if (type === 'machine') {
            detailData = originalData.filter(row => {
                const isDateInRange = row.Fecha >= startDate && row.Fecha <= endDate;
                return row.Descrip_Maquina === category && isDateInRange;
            });
            modalTitleText = `Detalle de Producción para: ${category}`;
            tableHeader = `<th>Fecha</th><th>Turno</th><th>Operario</th><th>Cantidad</th><th>Incidencia</th><th>Minutos Parada</th>`;
            
            const seenProdIds = new Set();
            detailData.forEach(row => {
                let isNewProd = false;
                if (row.IdProduccion && !seenProdIds.has(row.IdProduccion)) {
                    seenProdIds.add(row.IdProduccion);
                    isNewProd = true;
                }
                tableBody += `
                    <tr>
                        <td>${row.Fecha.toLocaleDateString('es-ES')}</td>
                        <td>${row.Turno || '--'}</td>
                        <td>${row.Apellido || '--'}</td>
                        <td>${isNewProd ? formatNumber(row.Cantidad) : ''}</td>
                        <td>${row.descrip_incidencia || ''}</td>
                        <td>${row.Minutos || ''}</td>
                    </tr>
                `;
            });

        } else if (type === 'downtime') {
            detailData = originalData.filter(row => {
                const isDateInRange = row.Fecha >= startDate && row.Fecha <= endDate;
                return row.descrip_incidencia === category && isDateInRange;
            });
            modalTitleText = `Detalle de Paradas por: ${category}`;
            tableHeader = `<th>Fecha</th><th>Máquina</th><th>Turno</th><th>Operario</th><th>Minutos Parada</th>`;
            
            detailData.forEach(row => {
                tableBody += `
                    <tr>
                        <td>${row.Fecha.toLocaleDateString('es-ES')}</td>
                        <td>${row.Descrip_Maquina || '--'}</td>
                        <td>${row.Turno || '--'}</td>
                        <td>${row.Apellido || '--'}</td>
                        <td>${row.Minutos || ''}</td>
                    </tr>
                `;
            });
        }

        const modalTitle = document.getElementById('detailModalLabel');
        const modalBody = document.getElementById('detailModalBody');
        
        modalTitle.textContent = modalTitleText;
        
        if (detailData.length === 0) {
            modalBody.innerHTML = "<p>No hay datos detallados para la selección actual.</p>";
        } else {
            modalBody.innerHTML = `
                <table class="table table-striped table-sm">
                    <thead><tr>${tableHeader}</tr></thead>
                    <tbody>${tableBody}</tbody>
                </table>
            `;
        }
        
        detailModal.show();
    }

    function updateCharts(data) {
        const dailyProdData = aggregateDailyProduction(data);
        renderChart('chart-daily-production', 'line', dailyProdData);
        
        const prodByMachineData = aggregateAndSort(data, 'Descrip_Maquina', 'Cantidad', true);
        renderChart('chart-prod-by-machine', 'bar', { seriesName: 'Producción', data: prodByMachineData, horizontal: true });
        
        const avgProdByOperatorData = calculateAverageProductionByShift(data);
        renderChart('chart-prod-by-operator', 'bar', { seriesName: 'Producción Promedio/Turno', data: avgProdByOperatorData, horizontal: false });
        
        const downtimeComboData = aggregateDowntime(data).sort((a,b) => b.totalMinutes - a.totalMinutes);
        renderChart('chart-downtime-combo', 'combo', downtimeComboData);
    }
    
    function renderChart(elementId, type, chartData) {
        const currentTheme = localStorage.getItem('dashboardTheme') || 'light';
        const textColor = currentTheme === 'dark' ? '#e0e0e0' : '#333';
        const gridBorderColor = currentTheme === 'dark' ? '#444' : '#e7e7e7';
        
        const commonOptions = {
            chart: { 
                height: 350, 
                fontFamily: 'Inter, sans-serif', 
                toolbar: { show: true }, 
                background: 'transparent',
                events: {
                    dataPointSelection: function(event, chartContext, config) {
                        const chartId = config.w.config.chart.id;
                        if (chartId === 'chart-prod-by-machine') {
                            const machineName = config.w.config.xaxis.categories[config.dataPointIndex];
                            showDrillDownModal(machineName, 'machine');
                        } else if (chartId === 'chart-downtime-combo') {
                            const reason = config.w.config.xaxis.categories[config.dataPointIndex];
                            showDrillDownModal(reason, 'downtime');
                        }
                    }
                },
                zoom: {
                    enabled: false
                },
                pan: {
                    enabled: true,
                    key: 'ctrl'
                },
                locales: [{
                    name: 'es',
                    options: {
                        months: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
                        shortMonths: ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'],
                        days: ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'],
                        shortDays: ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'],
                        toolbar: {
                            download: 'Descargar SVG',
                            selection: 'Selección',
                            selectionZoom: 'Zoom de selección',
                            zoomIn: 'Acercar (Ctrl+Scroll)',
                            zoomOut: 'Alejar (Ctrl+Scroll)',
                            pan: 'Mover (Ctrl + Clic)',
                            reset: 'Restablecer Zoom'
                        }
                    }
                }],
                defaultLocale: 'es'
            },
            theme: { mode: currentTheme },
            colors: chartColors,
            grid: { borderColor: gridBorderColor },
            noData: { text: 'No hay datos para la selección actual.' },
        };

        let options = {};
        if (type === 'line') {
            options = {
                ...commonOptions, chart: {...commonOptions.chart, id: elementId, type: 'line'}, series: chartData.series,
                stroke: { curve: 'smooth', width: 3 },
                markers: { size: 5 },
                dataLabels: { 
                    enabled: true, 
                    offsetY: -15, 
                    formatter: (val) => formatNumber(val),
                    style: { colors: ["#000000"] }, 
                    background: { 
                        enabled: true, 
                        foreColor: '#000', 
                        borderRadius: 3, 
                        padding: 5, 
                        opacity: 0.9, 
                        borderColor: '#BDE5F8',
                        backgroundColor: '#BDE5F8'
                    } 
                },
                xaxis: { type: 'datetime', categories: chartData.categories, labels: { style: { colors: textColor }, datetimeUTC: false, format: 'dd MMM' } },
                yaxis: { labels: { style: { colors: textColor }, formatter: (val) => formatNumber(val) } },
                tooltip: { 
                    theme: currentTheme, 
                    x: { format: 'dddd dd/MM/yyyy' }, 
                    y: { formatter: (val) => `${formatNumber(val)} pzas.` } 
                }
            };
        } else if (type === 'bar') {
             options = {
                ...commonOptions, 
                chart: {...commonOptions.chart, id: elementId, type: 'bar'},
                series: [{ name: chartData.seriesName, data: chartData.data.map(d => d.value) }],
                plotOptions: { bar: { horizontal: chartData.horizontal || false, borderRadius: 4, dataLabels: { position: 'top' } } },
                dataLabels: { enabled: true, formatter: (val) => formatNumber(val), style: { fontSize: '12px' }, offsetY: -20, dropShadow: { enabled: true, top: 1, left: 1, blur: 1, color: '#000', opacity: 0.45 }},
                xaxis: { categories: chartData.data.map(d => d.category), labels: { style: { colors: textColor, fontSize: '12px' }, trim: true, maxHeight: 100 } },
                yaxis: { labels: { style: { colors: textColor }, formatter: (val) => formatNumber(val) } },
                tooltip: { theme: currentTheme, y: { formatter: (val) => formatNumber(val) } }
            };
            if (chartData.horizontal) { options.dataLabels.style.colors = ["#fff"]; options.dataLabels.offsetX = -10; } 
            else { options.dataLabels.style.colors = [textColor]; }
        } else if (type === 'combo') {
            options = {
                ...commonOptions, chart: {...commonOptions.chart, id: elementId, type: 'line', stacked: false},
                series: [
                    { name: 'Tiempo (Horas)', type: 'column', data: chartData.map(d => parseFloat((d.totalMinutes / 60).toFixed(2))) },
                    { name: 'Frecuencia', type: 'line', data: chartData.map(d => d.totalFrequency) }
                ],
                stroke: { width: [0, 4], curve: 'smooth' },
                xaxis: { categories: chartData.map(d => d.reason), labels: { style: { colors: textColor, fontSize: '11px' }, trim: true, rotate: -45, hideOverlappingLabels: true, maxHeight: 120 } },
                yaxis: [
                    { seriesName: 'Tiempo (Horas)', axisTicks: { show: true }, axisBorder: { show: true, color: chartColors[0] }, labels: { style: { colors: chartColors[0] }, formatter: (val) => formatNumber(val) }, title: { text: "Tiempo Total (Horas)", style: { color: chartColors[0] } }},
                    { seriesName: 'Frecuencia', opposite: true, axisTicks: { show: true }, axisBorder: { show: true, color: chartColors[1] }, labels: { style: { colors: chartColors[1] }, formatter: (val) => formatNumber(val) }, title: { text: "Frecuencia (Nro. de Veces)", style: { color: chartColors[1] } }}
                ],
                tooltip: { 
                    theme: currentTheme,
                    y: {
                        formatter: function(val, { seriesIndex }) {
                            if(val === undefined) return val;
                            if (seriesIndex === 0) {
                                return val.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " Hs";
                            } else {
                                return val.toLocaleString('es-ES') + " veces";
                            }
                        }
                    }
                },
                legend: { horizontalAlign: 'left', offsetX: 40 }
            };
        }

        if (charts[elementId]) {
            charts[elementId].updateOptions(options, true, true, true);
        } else {
            charts[elementId] = new ApexCharts(document.querySelector(`#${elementId}`), options);
            charts[elementId].render().then(() => {
                const chartEl = document.querySelector(`#${elementId}`);
                if (chartEl) {
                    chartEl.addEventListener('wheel', (event) => {
                        if (event.ctrlKey) {
                            event.preventDefault();
                            if (event.deltaY < 0) {
                                charts[elementId].zoomIn();
                            } else {
                                charts[elementId].zoomOut();
                            }
                        }
                    });
                }
            });
        }
    }
    
    function aggregateDailyProduction(data) {
        const aggregation = {};
        const seenProdIds = new Set();
        data.forEach(row => {
            if (row.Fecha) {
                const dateCategory = row.Fecha.toISOString().split('T')[0];
                const uniqueKey = `${dateCategory}-${row.IdProduccion}`;
                if (row.IdProduccion && !seenProdIds.has(uniqueKey)) {
                    aggregation[dateCategory] = (aggregation[dateCategory] || 0) + row.Cantidad;
                    seenProdIds.add(uniqueKey);
                }
            }
        });
        const sorted = Object.keys(aggregation).sort((a, b) => new Date(a) - new Date(b));
        return {
            series: [{ name: 'Producción', data: sorted.map(key => aggregation[key]) }],
            categories: sorted.map(key => {
                const parts = key.split('-');
                return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
            })
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
                if (!seenIds.has(uniqueKey)) { aggregation[category] = (aggregation[category] || 0) + value; seenIds.add(uniqueKey); }
            } else { aggregation[category] = (aggregation[category] || 0) + value; }
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
                operatorStats[operator] = {
                    totalProduction: 0,
                    shifts: new Set()
                };
            }

            const uniqueProdKey = `${row.IdProduccion}-${operator}`;
            if (!seenProdIds.has(uniqueProdKey)) {
                operatorStats[operator].totalProduction += row.Cantidad;
                seenProdIds.add(uniqueProdKey);
            }
            
            if (row.Turno && row.Fecha) {
                const dateString = row.Fecha.toISOString().split('T')[0];
                operatorStats[operator].shifts.add(`${dateString};${row.Turno}`);
            }
        });

        const result = Object.keys(operatorStats).map(operator => {
            const stats = operatorStats[operator];
            const shiftCount = stats.shifts.size;
            const average = shiftCount > 0 ? stats.totalProduction / shiftCount : 0;
            return {
                category: operator,
                value: average
            };
        });
        
        return result.sort((a, b) => b.value - a.value);
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

    // --- AI Assistant Chat Functions ---
    function initAIChat() {
        aiAssistantBtn.addEventListener('click', () => toggleChat(true));
        closeChatBtn.addEventListener('click', () => toggleChat(false));
        sendChatBtn.addEventListener('click', sendMessage);
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendMessage();
            }
        });
        const maximizeChatBtn = document.getElementById('maximize-chat-btn');
        maximizeChatBtn.addEventListener('click', () => {
            const icon = maximizeChatBtn.querySelector('i');
            if (chatContainer.classList.contains('ai-chat-container-maximized')) {
                chatContainer.classList.remove('ai-chat-container-maximized');
                icon.classList.remove('fa-compress');
                icon.classList.add('fa-expand');
            } else {
                chatContainer.classList.add('ai-chat-container-maximized');
                icon.classList.remove('fa-expand');
                icon.classList.add('fa-compress');
            }
        });
    }

    function toggleChat(show) {
        chatContainer.style.display = show ? 'flex' : 'none';
        if (show) {
            chatInput.focus();
        }
    }

    function addMessage(message, sender) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('chat-message', `${sender}-message`);
        messageElement.textContent = message;
        chatBody.appendChild(messageElement);
        chatBody.scrollTop = chatBody.scrollHeight;
    }

    async function sendMessage() {
    const userInput = chatInput.value.trim();
    if (!userInput) return;

    addMessage(userInput, 'user');
    chatInput.value = '';
    toggleLoading(true);

    if (API_KEY === 'YOUR_API_KEY') {
        addMessage('Por favor, reemplaza YOUR_API_KEY en app.js con tu clave de API de Google AI Studio.', 'bot');
        toggleLoading(false);
        return;
    }

    const filteredData = getFilteredData();
    const kpiData = calculateKPIs(filteredData);
    const downtimeSummary = aggregateDowntime(filteredData).sort((a, b) => b.totalMinutes - a.totalMinutes).slice(0, 5);
    const prodByMachineSummary = aggregateAndSort(filteredData, 'Descrip_Maquina', 'Cantidad', true).slice(0, 5);

    const dateRange = datepicker.selectedDates.map(d => d.toLocaleDateString('es-ES')).join(' al ');
    const selectedMachines = choicesMachine.getValue(true);
    const selectedShifts = choicesShift.getValue(true);

    const dashboardContext = `
    **Contexto Actual del Dashboard:**

    *   **Filtros Activos:**
        *   Rango de Fechas: ${dateRange || 'No especificado'}
        *   Máquinas: ${selectedMachines.length > 0 ? selectedMachines.join(', ') : 'Todas'}
        *   Turnos: ${selectedShifts.length > 0 ? selectedShifts.join(', ') : 'Todos'}

    *   **KPIs Principales:**
        *   Producción Total: ${formatNumber(kpiData.totalProduction)} pzas.
        *   Disponibilidad: ${(kpiData.availability * 100).toFixed(1)}%
        *   Eficiencia (Pzas/Turno): ${formatNumber(kpiData.efficiency)}
        *   Horas de Parada Totales: ${kpiData.totalDowntimeHours.toFixed(1)} hs.

    *   **Resumen de Gráficos:**
        *   Top 5 Máquinas por Producción:
            ${prodByMachineSummary.map(item => `- ${item.category}: ${formatNumber(item.value)} pzas.`).join('\n            ')}
        *   Top 5 Causas de Parada por Tiempo:
            ${downtimeSummary.map(item => `- ${item.reason}: ${(item.totalMinutes / 60).toFixed(1)} hs.`).join('\n            ')}
    `;

    const dataSummary = Papa.unparse(filteredData.slice(0, 200)); 

    const prompt = `
**Instrucciones:**
Eres un asistente de IA de élite, especializado en el análisis de datos de producción industrial. Tu único propósito es actuar como un analista experto para el usuario, proporcionando respuestas concisas, claras y directas.

**Cómo Debes Analizar y Razonar:**
1.  **Prioriza el Contexto del Dashboard:** Tu primera fuente de verdad es el resumen del dashboard que se te proporciona a continuación. Esto simula tu "visión" de la pantalla. Basa tu respuesta en esta información.
2.  **Consulta los Datos Crudos como Último Recurso:** Junto con el contexto, recibirás una porción de los datos en formato CSV. Úsalos solo cuando necesites verificar un detalle muy específico que no esté en el resumen para responder la pregunta del usuario.
3.  **Sé Proactivo:** Si los datos revelan un problema crítico (ej. una máquina con un tiempo de inactividad desproporcionado), menciónalo brevemente.

**Reglas Estrictas para tus Respuestas:**
*   **NUNCA Muestres tu Trabajo:** Jamás incluyas código, los datos CSV, o una descripción de tu proceso de análisis.
*   **Sé Extremadamente Conciso:** Ve directo al grano.
*   **Habla como un Humano Experto:** No uses frases como "Analizando los datos...". Simplemente presenta los hechos.

---

${dashboardContext}

---

**Datos Crudos de Referencia (CSV):**
${dataSummary}

---

**Pregunta del Usuario:**
${userInput}
`;

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: prompt,
                    }],
                }],
            }),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        const botResponse = data.candidates[0].content.parts[0].text;
        addMessage(botResponse, 'bot');
    } catch (error) {
        console.error('Error en la API de Gemini:', error);
        addMessage('Hubo un error al contactar al asistente de IA. Revisa la consola para más detalles.', 'bot');
    } finally {
        toggleLoading(false);
    }
}

    init();
});