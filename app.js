document.addEventListener('DOMContentLoaded', function () {
    const CSV_URL = 'exportProduccionyEventos.csv';

    // --- STATE MANAGEMENT ---
    let charts = {};
    let choicesMachine, choicesShift, datepicker;
    let detailModal;
    let currentFilteredData = [];
    let fullDowntimeData = [];
    let selectedOperator = null;

    // --- UI ELEMENTS ---
    const loadingOverlay = document.getElementById('loading-overlay');
    const progressContainer = document.getElementById('progress-container');
    const progressCircle = document.querySelector('.progress-circle');
    const progressText = document.querySelector('.progress-text');
    const progressStatusText = document.getElementById('progress-status-text');
    const themeToggle = document.getElementById('theme-toggle');
    let downtimeFilter;
    const operatorFilterDisplay = document.getElementById('operator-filter-display');
    const operatorFilterName = document.getElementById('operator-filter-name');
    
    const chartColors = ['#5E35B1', '#039BE5', '#00897B', '#FDD835', '#E53935', '#8E24AA', '#3949AB'];
    const formatNumber = (val) => val ? val.toLocaleString('es-ES', { maximumFractionDigits: 0 }) : val;

    // --- WEB WORKER ---
    const worker = new Worker('worker.js');

    worker.onmessage = function(e) {
        const { type, payload } = e.data;

        switch (type) {
            case 'data_loaded':
                populateFilters(payload.uniqueMachines, payload.uniqueShifts);
                addEventListeners();
                const today = new Date();
                const startOfPreviousMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                datepicker.setDate([startOfPreviousMonth, today], true);
                document.getElementById('last-updated').textContent = `Actualizado: ${new Date().toLocaleString('es-ES')}`;
                break;
            
            case 'update_dashboard':
                currentFilteredData = payload.filteredData;
                fullDowntimeData = payload.chartsData.downtimeComboData || [];
                updateDashboard(payload.kpiData, payload.chartsData, payload.summaryData);
                break;

            case 'progress':
                toggleProgress(true, payload.progress, payload.status);
                break;

            case 'error':
                console.error("Error from worker:", payload);
                alert("Ocurrió un error al procesar los datos. Revisa la consola.");
                toggleProgress(false);
                break;
        }
    };

    // --- INITIALIZATION ---
    function init() {
        initTheme();
        detailModal = new bootstrap.Modal(document.getElementById('detailModal'));
        toggleOverlay(true);
        worker.postMessage({ type: 'load_data', payload: { url: CSV_URL } });
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

    function populateFilters(uniqueMachines, uniqueShifts) {
        const machineFilterEl = document.getElementById('machine-filter');
        uniqueMachines.forEach(machine => machineFilterEl.add(new Option(machine, machine)));
        const shiftFilterEl = document.getElementById('shift-filter');
        uniqueShifts.forEach(shift => shiftFilterEl.add(new Option(shift, shift)));
        
        choicesMachine = new Choices(machineFilterEl, { removeItemButton: true, placeholder: true, placeholderValue: 'Todas las máquinas...' });
        choicesShift = new Choices(shiftFilterEl, { removeItemButton: true, placeholder: true, placeholderValue: 'Todos los turnos...' });
    }

    function addEventListeners() {
        datepicker = flatpickr("#date-range-picker", {
            mode: "range",
            dateFormat: "d/m/Y",
            locale: "es",
            onChange: () => applyFilters()
        });

        document.getElementById('machine-filter').addEventListener('change', applyFilters);
        document.getElementById('shift-filter').addEventListener('change', applyFilters);
        document.getElementById('extended-analysis-toggle').addEventListener('change', applyFilters);
        document.getElementById('daily-prod-agg-options').addEventListener('change', applyFilters);
        document.getElementById('clear-operator-filter').addEventListener('click', clearOperatorFilter);

        downtimeFilter = document.getElementById('downtime-filter');
        downtimeFilter.addEventListener('change', filterAndRenderDowntimeChart);

        const today = new Date();
        document.getElementById('btnMesActual').addEventListener('click', () => datepicker.setDate([new Date(today.getFullYear(), today.getMonth(), 1), today], true));
        document.getElementById('btnMesAnterior').addEventListener('click', () => {
             const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
             const end = new Date(today.getFullYear(), today.getMonth(), 0);
             datepicker.setDate([start, end], true);
        });
        document.getElementById('btnSemanaActual').addEventListener('click', () => {
            const first = today.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1);
            datepicker.setDate([new Date(new Date().setDate(first)), new Date()], true);
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
            document.getElementById('extended-analysis-toggle').checked = false;
            downtimeFilter.value = 'all';
            document.getElementById('aggTotal').checked = true;
            clearOperatorFilter();
        });
    }

    // --- DATA FLOW & UI UPDATES ---

    function applyOperatorFilter(operatorName) {
        selectedOperator = operatorName;
        operatorFilterName.textContent = operatorName;
        operatorFilterDisplay.style.display = 'block';
        applyFilters();
    }

    function clearOperatorFilter() {
        selectedOperator = null;
        operatorFilterDisplay.style.display = 'none';
        applyFilters();
    }

    function applyFilters() {
        toggleProgress(true, 0, 'Filtrando datos...');
        const dailyAgg = document.querySelector('input[name="dailyAgg"]:checked')?.value || 'total';
        const filterValues = {
            dateRange: datepicker.selectedDates,
            selectedMachines: choicesMachine.getValue(true),
            selectedShifts: choicesShift.getValue(true),
            isExtended: document.getElementById('extended-analysis-toggle').checked,
            dailyAggregationType: dailyAgg,
            selectedOperator: selectedOperator
        };
        worker.postMessage({ type: 'apply_filters', payload: filterValues });
    }

    function toggleOverlay(show) {
        loadingOverlay.style.display = show ? 'flex' : 'none';
    }

    function toggleProgress(show, progress = 0, status = 'Cargando...') {
        if (show) {
            progressContainer.style.display = 'flex';
            progressText.textContent = `${Math.round(progress)}%`;
            progressCircle.style.background = `conic-gradient(var(--primary-color) ${progress * 3.6}deg, #444 0deg)`;
            progressStatusText.textContent = status;
        } else {
            progressContainer.style.display = 'none';
        }
    }

    function applyTheme(theme) {
        document.body.setAttribute('data-theme', theme);
        themeToggle.checked = theme === 'dark';
        Object.values(charts).forEach(chart => {
            if (chart.chart) {
                chart.updateOptions({ theme: { mode: theme }, chart: { background: 'transparent' } });
            }
        });
    }

    function updateDashboard(kpiData, chartsData, summaryData) {
        renderKPIs(kpiData);
        renderSummary(summaryData);
        updateCharts(chartsData);
        toggleProgress(false);
        toggleOverlay(false);
    }

    function renderKPIs(kpiData) {
        document.getElementById('kpi-total-production').textContent = formatNumber(kpiData.totalProduction);
        document.getElementById('kpi-availability').textContent = `${(kpiData.availability * 100).toFixed(1)}%`;
        document.getElementById('kpi-efficiency').textContent = formatNumber(kpiData.efficiency);
        document.getElementById('kpi-total-downtime').textContent = kpiData.totalDowntimeHours.toFixed(1);
    }

    function renderSummary(summaryData) {
        const summaryElement = document.getElementById('management-summary');
        if (!summaryData || summaryData.topReason === 'N/A') {
            summaryElement.innerHTML = 'No hay datos suficientes para generar un resumen.';
            return;
        }

        let summaryHTML = `
            La <strong>disponibilidad</strong> general fue de un <strong>${summaryData.availabilityPercentage}%</strong>. 
            La principal causa de parada fue "<strong>${summaryData.topReason}</strong>", 
            representando un <strong>${summaryData.topReasonPercentage}%</strong> del tiempo total de inactividad.
        `;
        summaryElement.innerHTML = summaryHTML;
    }
    
    function updateCharts(chartsData) {
        renderChart('chart-daily-production', 'line', chartsData.dailyProdData);
        renderChart('chart-prod-by-machine', 'bar', { seriesName: 'Producción', data: chartsData.prodByMachineData, horizontal: true });
        renderChart('chart-prod-by-operator', 'bar', { seriesName: 'Producción Promedio/Turno', data: chartsData.avgProdByOperatorData, horizontal: false });
        filterAndRenderDowntimeChart();
        renderChart('chart-daily-time-distribution', 'stackedBar', chartsData.dailyTimeData);
    }

    function filterAndRenderDowntimeChart() {
        const filterValue = downtimeFilter.value;
        let dataToRender = [...fullDowntimeData];

        if (filterValue === 'top5_time') {
            dataToRender.sort((a, b) => b.totalMinutes - a.totalMinutes);
            dataToRender = dataToRender.slice(0, 5);
        } else if (filterValue === 'top5_freq') {
            dataToRender.sort((a, b) => b.totalFrequency - a.totalFrequency);
            dataToRender = dataToRender.slice(0, 5);
        } else { 
            dataToRender.sort((a, b) => b.totalMinutes - a.totalMinutes);
        }

        renderChart('chart-downtime-combo', 'combo', dataToRender);
    }

    function showDrillDownModal(category, type = 'machine') {
        // ... (existing modal logic)
    }
    
    function renderChart(elementId, type, chartData) {
        if (!chartData) { console.warn(`No data for chart: ${elementId}`); return; }
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
                        const category = config.w.config.xaxis.categories[config.dataPointIndex];
                        
                        if (chartId === 'chart-prod-by-operator') {
                            applyOperatorFilter(category);
                        } else if (chartId === 'chart-prod-by-machine') {
                            showDrillDownModal(category, 'machine');
                        } else if (chartId === 'chart-downtime-combo') {
                            showDrillDownModal(category, 'downtime');
                        }
                    }
                },
                zoom: { enabled: true, type: 'xy' },
                pan: { enabled: true, key: 'ctrl' },
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
            const dailyAgg = document.querySelector('input[name="dailyAgg"]:checked')?.value || 'total';
            let diffDays = 0;
            if (datepicker.selectedDates.length === 2) {
                const diffTime = Math.abs(datepicker.selectedDates[1] - datepicker.selectedDates[0]);
                diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            }
            const showLabels = dailyAgg === 'total' || diffDays <= 7;

            options = {
                ...commonOptions, chart: {...commonOptions.chart, id: elementId, type: 'line'}, series: chartData.series,
                stroke: { curve: 'smooth', width: 3 },
                markers: { size: 5 },
                dataLabels: {
                    enabled: showLabels,
                    offsetY: -15,
                    formatter: (val) => {
                        if (val === null || val === undefined) return '';
                        return formatNumber(val);
                    },
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
            // ... (existing combo logic)
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
                            charts[elementId][event.deltaY < 0 ? 'zoomIn' : 'zoomOut']();
                        }
                    });
                }
            });
        }
    }
    
    // --- START ---
    init();
});