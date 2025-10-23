document.addEventListener('DOMContentLoaded', function () {
    const CSV_URL = 'exportProduccionyEventos.csv';

    // --- STATE MANAGEMENT ---
    let charts = {};
    let choicesMachine, choicesShift, choicesMachineGroup, datepicker;
    let detailModal;
    let currentFilteredData = [];
    let fullDowntimeData = [];
    let dailyProdData = {}; // Store data for re-renders
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
                populateFilters(payload.uniqueMachines, payload.uniqueShifts, payload.uniqueMachineGroups);
                addEventListeners();
                const today = new Date();
                const startOfPreviousMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                datepicker.setDate([startOfPreviousMonth, today], true);
                document.getElementById('last-updated').textContent = `Actualizado: ${new Date().toLocaleString('es-ES')}`;
                break;
            
            case 'update_dashboard':
                currentFilteredData = payload.filteredData;
                fullDowntimeData = payload.chartsData.downtimeComboData || [];
                dailyProdData = payload.chartsData.dailyProdData || {};
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

    function populateFilters(uniqueMachines, uniqueShifts, uniqueMachineGroups) {
        const machineFilterEl = document.getElementById('machine-filter');
        uniqueMachines.forEach(machine => machineFilterEl.add(new Option(machine, machine)));
        const shiftFilterEl = document.getElementById('shift-filter');
        uniqueShifts.forEach(shift => shiftFilterEl.add(new Option(shift, shift)));
        const machineGroupFilterEl = document.getElementById('machine-group-filter');
        uniqueMachineGroups.forEach(group => machineGroupFilterEl.add(new Option(group, group)));
        
        choicesMachine = new Choices(machineFilterEl, { removeItemButton: true, placeholder: true, placeholderValue: 'Todas las máquinas...' });
        choicesShift = new Choices(shiftFilterEl, { removeItemButton: true, placeholder: true, placeholderValue: 'Todos los turnos...' });
        choicesMachineGroup = new Choices(machineGroupFilterEl, { placeholder: true, placeholderValue: 'Todos los grupos...', searchEnabled: false, removeItemButton: false });
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
        document.getElementById('machine-group-filter').addEventListener('change', applyFilters);
        document.getElementById('extended-analysis-toggle').addEventListener('change', applyFilters);
        document.getElementById('daily-prod-agg-options')?.addEventListener('change', applyFilters);
        document.getElementById('clear-operator-filter')?.addEventListener('click', clearOperatorFilter);
        document.getElementById('apply-yaxis-scale')?.addEventListener('click', rerenderDailyProdChart);

        downtimeFilter = document.getElementById('downtime-filter');
        if (downtimeFilter) {
            downtimeFilter.addEventListener('change', filterAndRenderDowntimeChart);
        }

        document.getElementById('btnMesActual').addEventListener('click', () => {
            const today = new Date();
            datepicker.setDate([new Date(today.getFullYear(), today.getMonth(), 1), today], true);
        });
        document.getElementById('btnMesAnterior').addEventListener('click', () => {
             const today = new Date();
             const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
             const end = new Date(today.getFullYear(), today.getMonth(), 0);
             datepicker.setDate([start, end], true);
        });
        document.getElementById('btnSemanaActual').addEventListener('click', () => {
            const today = new Date();
            const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
            const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
            const startOfWeek = new Date(today);
            startOfWeek.setDate(today.getDate() - diff);
            startOfWeek.setHours(0, 0, 0, 0);
            datepicker.setDate([startOfWeek, today], true);
        });
         document.getElementById('btnSemanaAnterior').addEventListener('click', () => {
            const today = new Date();
            // Adjust day of week so Monday is 1 and Sunday is 7
            const dayOfWeek = today.getDay();
            const adjustedDay = (dayOfWeek === 0) ? 7 : dayOfWeek;

            // The end of the previous week is the Sunday before the current week
            const endOfLastWeek = new Date(today);
            endOfLastWeek.setDate(today.getDate() - adjustedDay);
            endOfLastWeek.setHours(23, 59, 59, 999);

            // The start of the previous week is 6 days before its end
            const startOfLastWeek = new Date(endOfLastWeek);
            startOfLastWeek.setDate(endOfLastWeek.getDate() - 6);
            startOfLastWeek.setHours(0, 0, 0, 0);

            datepicker.setDate([startOfLastWeek, endOfLastWeek], true);
        });

        document.getElementById('reset-filters').addEventListener('click', () => {
            const today = new Date();
            const startOfPreviousMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            
            choicesMachine.removeActiveItems();
            choicesShift.removeActiveItems();
            choicesMachineGroup.setChoiceByValue(''); // Resetea el filtro de grupo
            localStorage.removeItem('lastSelectedMachineGroup'); // Limpia la caché del filtro de grupo
            document.getElementById('extended-analysis-toggle').checked = false;
            if(downtimeFilter) downtimeFilter.value = 'all';
            
            const aggTotal = document.getElementById('aggTotal');
            if(aggTotal) aggTotal.checked = true;

            const yAxisMinEl = document.getElementById('yaxis-min');
            const yAxisMaxEl = document.getElementById('yaxis-max');
            if(yAxisMinEl) yAxisMinEl.value = '';
            if(yAxisMaxEl) yAxisMaxEl.value = '';
            
            selectedOperator = null;
            if(operatorFilterDisplay) operatorFilterDisplay.style.display = 'none';

            datepicker.setDate([startOfPreviousMonth, today], true);
        });
    }

    // --- DATA FLOW & UI UPDATES ---

    function applyOperatorFilter(operatorName) {
        selectedOperator = operatorName;
        if(operatorFilterName) operatorFilterName.textContent = operatorName;
        if(operatorFilterDisplay) operatorFilterDisplay.style.display = 'block';
        applyFilters();
    }

    function clearOperatorFilter() {
        selectedOperator = null;
        if(operatorFilterDisplay) operatorFilterDisplay.style.display = 'none';
        applyFilters();
    }

    function applyFilters() {
        toggleProgress(true, 0, 'Filtrando datos...');
        const dailyAggInput = document.querySelector('input[name="dailyAgg"]:checked');
        const dailyAgg = dailyAggInput ? dailyAggInput.value : 'total';
        
        const selectedMachineGroup = choicesMachineGroup.getValue(true);
        localStorage.setItem('lastSelectedMachineGroup', selectedMachineGroup); // Guarda la selección en caché

        const filterValues = {
            dateRange: datepicker.selectedDates,
            selectedMachines: choicesMachine.getValue(true),
            selectedShifts: choicesShift.getValue(true),
            selectedMachineGroup: selectedMachineGroup === '' ? null : selectedMachineGroup, // Envía null si es el placeholder "Todos los grupos..."
            isExtended: document.getElementById('extended-analysis-toggle').checked,
            dailyAggregationType: dailyAgg,
            selectedOperator: selectedOperator
        };
        worker.postMessage({ type: 'apply_filters', payload: filterValues });
    }

    function rerenderDailyProdChart() {
        renderChart('chart-daily-production', 'line', dailyProdData);
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
        dailyProdData = chartsData.dailyProdData || {};
        renderChart('chart-daily-production', 'line', dailyProdData);
        renderChart('chart-prod-by-machine', 'bar', { seriesName: 'Producción', data: chartsData.prodByMachineData, horizontal: true });
        renderChart('chart-prod-by-operator', 'bar', { seriesName: 'Producción Promedio/Turno', data: chartsData.avgProdByOperatorData, horizontal: false });
        filterAndRenderDowntimeChart();
        renderChart('chart-daily-time-distribution', 'stackedBar', chartsData.dailyTimeData);
    }

    function filterAndRenderDowntimeChart() {
        if (!downtimeFilter) return;
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
        const modalTitle = document.getElementById('detailModalLabel');
        const modalBody = document.getElementById('detailModalBody');
        let data, title, headers, body;

        if (type === 'machine') {
            data = currentFilteredData.filter(row => row.Descrip_Maquina === category);
            title = `Detalle de Producción para: ${category}`;
            headers = ["Fecha", "Turno", "Operario", "Producción", "Incidencia", "Minutos Parada"];
            
            let lastId = null;
            body = data.sort((a, b) => a.IdProduccion - b.IdProduccion || a.Fecha - b.Fecha || a.Turno - b.Turno)
                       .map(row => {
                           let rowHtml;
                           if (row.IdProduccion && row.IdProduccion === lastId) {
                               rowHtml = `<tr>
                                   <td></td>
                                   <td></td>
                                   <td></td>
                                   <td></td>
                                   <td>${row.descrip_incidencia || ''}</td>
                                   <td>${row.Minutos || ''}</td>
                               </tr>`;
                           } else {
                               rowHtml = `<tr>
                                   <td>${row.Fecha.toLocaleDateString('es-ES')}</td>
                                   <td>${row.Turno}</td>
                                   <td>${row.Apellido || 'N/A'}</td>
                                   <td>${formatNumber(row.Cantidad)}</td>
                                   <td>${row.descrip_incidencia || ''}</td>
                                   <td>${row.Minutos || ''}</td>
                               </tr>`;
                               lastId = row.IdProduccion;
                           }
                           return rowHtml;
                       });

        } else if (type === 'downtime') {
            data = currentFilteredData.filter(row => row.descrip_incidencia === category);
            title = `Detalle de Paradas por: ${category}`;
            headers = ["Fecha", "Máquina", "Turno", "Operario", "Minutos Parada"];
            body = data.sort((a, b) => a.Fecha - b.Fecha || a.Turno - b.Turno)
                       .map(row => `<tr>
                           <td>${row.Fecha.toLocaleDateString('es-ES')}</td>
                           <td>${row.Descrip_Maquina}</td>
                           <td>${row.Turno}</td>
                           <td>${row.Apellido || 'N/A'}</td>
                           <td>${row.Minutos}</td>
                       </tr>`);
        }

        modalTitle.textContent = title;
        if (data.length > 0) {
            modalBody.innerHTML = `
                <div class="d-flex justify-content-end mb-3">
                    <button id="export-pdf" class="btn btn-sm btn-danger me-2"><i class="fas fa-file-pdf me-1"></i>Exportar a PDF</button>
                    <button id="export-excel" class="btn btn-sm btn-success"><i class="fas fa-file-excel me-1"></i>Exportar a Excel</button>
                </div>
                <div class="table-responsive modal-table-container">
                    <table class="table table-striped table-hover table-sm">
                        <thead class="table-dark"><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
                        <tbody>${body.join('')}</tbody>
                    </table>
                </div>`;

            document.getElementById('export-pdf').addEventListener('click', () => exportToPDF(data, headers, title));
            document.getElementById('export-excel').addEventListener('click', () => exportToExcel(data, headers, title));
        } else {
            modalBody.innerHTML = '<p>No hay datos detallados para la selección actual.</p>';
        }

        detailModal.show();
    }

    function exportToPDF(data, headers, title) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();

        const tableData = data.map(row => {
            if (headers.length === 6) { // Machine detail
                return [row.Fecha.toLocaleDateString('es-ES'), row.Turno, row.Apellido || 'N/A', formatNumber(row.Cantidad), row.descrip_incidencia || '', row.Minutos || ''];
            } else { // Downtime detail
                return [row.Fecha.toLocaleDateString('es-ES'), row.Descrip_Maquina, row.Turno, row.Apellido || 'N/A', row.Minutos];
            }
        });

        doc.autoTable({
            head: [headers],
            body: tableData,
            didDrawPage: function (data) {
                doc.text(title, data.settings.margin.left, 15);
            }
        });

        doc.save(`${title.replace(/ /g, "_")}.pdf`);
    }

    function exportToExcel(data, headers, title) {
        const csvContent = [headers.join(';'), ...data.map(row => {
            if (headers.length === 6) { // Machine detail
                return [row.Fecha.toLocaleDateString('es-ES'), row.Turno, row.Apellido || 'N/A', row.Cantidad, `"${row.descrip_incidencia || ''}"`, row.Minutos || ''].join(';');
            } else { // Downtime detail
                return [row.Fecha.toLocaleDateString('es-ES'), row.Descrip_Maquina, row.Turno, row.Apellido || 'N/A', row.Minutos].join(';');
            }
        })].join('\n');

        const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute("download", `${title.replace(/ /g, "_")}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
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
                        if (!config.w.config.xaxis.categories || config.dataPointIndex < 0) return;
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

            const yAxisMin = parseFloat(document.getElementById('yaxis-min')?.value);
            const yAxisMax = parseFloat(document.getElementById('yaxis-max')?.value);

            let yAxisConfig = {
                labels: { 
                    style: { colors: textColor }, 
                    formatter: (val) => formatNumber(val) 
                }
            };

            if (!isNaN(yAxisMin)) yAxisConfig.min = yAxisMin;
            if (!isNaN(yAxisMax)) yAxisConfig.max = yAxisMax;

            options = {
                ...commonOptions, 
                chart: {...commonOptions.chart, id: elementId, type: 'line'},
                series: chartData.series,
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
                yaxis: yAxisConfig,
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
                    { name: 'Tiempo (Horas)', type: 'column', data: chartData.map(d => parseFloat((d.totalMinutes / 60).toFixed(1))) },
                    { name: 'Frecuencia', type: 'line', data: chartData.map(d => d.totalFrequency) }
                ],
                stroke: { width: [0, 4], curve: 'smooth' },
                xaxis: { categories: chartData.map(d => d.reason), labels: { style: { colors: textColor, fontSize: '11px' }, trim: true, rotate: -45, hideOverlappingLabels: true, maxHeight: 120 } },
                yaxis: [
                    { seriesName: 'Tiempo (Horas)', axisTicks: { show: true }, axisBorder: { show: true, color: chartColors[0] }, labels: { style: { colors: chartColors[0] }, formatter: (val) => val.toFixed(1) }, title: { text: "Tiempo Total (Horas)", style: { color: chartColors[0] } }},
                    { seriesName: 'Frecuencia', opposite: true, axisTicks: { show: true }, axisBorder: { show: true, color: chartColors[1] }, labels: { style: { colors: chartColors[1] }, formatter: (val) => formatNumber(val) }, title: { text: "Frecuencia (Nro. de Veces)", style: { color: chartColors[1] } }}
                ],
                tooltip: {
                    theme: currentTheme,
                    y: {
                        formatter: function(val, { seriesIndex }) {
                            if(val === undefined) return val;
                            return seriesIndex === 0 ? `${val.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Hs` : `${val.toLocaleString('es-ES')} veces`;
                        }
                    }
                },
                legend: { horizontalAlign: 'left', offsetX: 40 }
            };
        } else if (type === 'stackedBar') {
            options = {
                ...commonOptions,
                chart: { ...commonOptions.chart, id: elementId, type: 'bar', stacked: true },
                plotOptions: { bar: { horizontal: false, dataLabels: { enabled: true, formatter: (val) => val < 0.1 ? '' : val.toFixed(1), style: { colors: ['#fff'], fontSize: '11px', fontWeight: 400 }, offsetY: 4 }}},
                series: chartData.series,
                xaxis: { type: 'datetime', categories: chartData.categories, labels: { style: { colors: textColor }, datetimeUTC: false, format: 'dd MMM' }},
                yaxis: { title: { text: 'Horas', style: { color: textColor }}, labels: { style: { colors: textColor }}},
                tooltip: { y: { formatter: (val) => `${val.toFixed(1)} horas` }},
                legend: { position: 'top', horizontalAlign: 'left' }
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
