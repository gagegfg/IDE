document.addEventListener('DOMContentLoaded', function () {
    const CSV_URL = 'exportProduccionyEventos.csv';
    const API_KEY = 'AIzaSyAYLOGw5vncaz1jN3uTsRvup3WeS1MBgQI'; // ¡¡¡REEMPLAZAR CON TU API KEY!!!
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${API_KEY}`;

    // --- STATE MANAGEMENT ---
    let charts = {};
    let choicesMachine, choicesShift, datepicker;
    let detailModal;
    let currentFilteredData = []; // Holds the currently filtered data for drill-downs and AI context
    let currentKpiData = {}; // Holds the current KPIs for the AI context

    // --- UI ELEMENTS ---
    const loadingOverlay = document.getElementById('loading-overlay');
    const progressContainer = document.getElementById('progress-container');
    const progressCircle = document.querySelector('.progress-circle');
    const progressText = document.querySelector('.progress-text');
    const progressStatusText = document.getElementById('progress-status-text');
    const themeToggle = document.getElementById('theme-toggle');
    const aiAssistantBtn = document.getElementById('ai-assistant-btn');
    const chatContainer = document.getElementById('ai-chat-container');
    const closeChatBtn = document.getElementById('close-chat-btn');
    const chatInput = document.getElementById('chat-input');
    const sendChatBtn = document.getElementById('send-chat-btn');
    const chatBody = document.getElementById('chat-body');
    
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
                // Set initial date range and trigger the first data load
                const today = new Date();
                const startOfPreviousMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                datepicker.setDate([startOfPreviousMonth, today], true);
                document.getElementById('last-updated').textContent = `Actualizado: ${new Date().toLocaleString('es-ES')}`;
                break;
            
            case 'update_dashboard':
                // The worker has finished processing. Let's update the UI.
                currentFilteredData = payload.filteredData;
                currentKpiData = payload.kpiData;
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
        initAIChat();
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
            onChange: function(selectedDates, dateStr, instance) {
                const isExtended = document.getElementById('extended-analysis-toggle').checked;
                if (!isExtended && selectedDates.length === 2) {
                    const diffTime = Math.abs(selectedDates[1] - selectedDates[0]);
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
                    if (diffDays > 122) { // Approx 4 months
                        alert("El rango no puede ser mayor a 4 meses en el modo de análisis normal. Active 'Análisis Extendido' para rangos más largos.");
                        // Revert to a valid range (e.g., 4 months from start)
                        const newEndDate = new Date(selectedDates[0]);
                        newEndDate.setMonth(newEndDate.getMonth() + 4);
                        instance.setDate([selectedDates[0], newEndDate]);
                        return; // Stop further processing
                    }
                }
                applyFilters();
            }
        });

        document.getElementById('machine-filter').addEventListener('change', applyFilters);
        document.getElementById('shift-filter').addEventListener('change', applyFilters);
        document.getElementById('extended-analysis-toggle').addEventListener('change', applyFilters);
        
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
        });
    }

    // --- DATA FLOW & UI UPDATES ---

    function applyFilters() {
        toggleProgress(true, 0, 'Filtrando datos...');
        const filterValues = {
            dateRange: datepicker.selectedDates,
            selectedMachines: choicesMachine.getValue(true),
            selectedShifts: choicesShift.getValue(true),
            isExtended: document.getElementById('extended-analysis-toggle').checked
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
        updateCharts(chartsData);
        updateSummary(summaryData);
        toggleProgress(false);
        toggleOverlay(false); // Also hide the initial overlay if it was visible
    }

    function renderKPIs(kpiData) {
        document.getElementById('kpi-total-production').textContent = formatNumber(kpiData.totalProduction);
        document.getElementById('kpi-availability').textContent = `${(kpiData.availability * 100).toFixed(1)}%`;
        document.getElementById('kpi-efficiency').textContent = formatNumber(kpiData.efficiency);
        document.getElementById('kpi-total-downtime').textContent = kpiData.totalDowntimeHours.toFixed(1);
    }
    
    function updateSummary(summaryData) {
        if (!summaryData || summaryData.topReason === 'N/A') {
            document.getElementById('summary-text').textContent = "No hay datos para el período o filtros seleccionados.";
            return;
        }
        const summary = `El KPI de <strong>Disponibilidad</strong> se sitúa en un <strong>${summaryData.availabilityPercentage}%</strong>. La principal causa de inactividad es <strong>"${summaryData.topReason}"</strong>, responsable del <strong>${summaryData.topReasonPercentage}%</strong> del tiempo total de parada.`;
        document.getElementById('summary-text').innerHTML = summary;
    }

    function updateCharts(chartsData) {
        renderChart('chart-daily-production', 'line', chartsData.dailyProdData);
        renderChart('chart-prod-by-machine', 'bar', { seriesName: 'Producción', data: chartsData.prodByMachineData, horizontal: true });
        renderChart('chart-prod-by-operator', 'bar', { seriesName: 'Producción Promedio/Turno', data: chartsData.avgProdByOperatorData, horizontal: false });
        renderChart('chart-downtime-combo', 'combo', chartsData.downtimeComboData);
        renderChart('chart-daily-time-distribution', 'stackedBar', chartsData.dailyTimeData);
    }

    function showDrillDownModal(category, type = 'machine') {
        let detailData, modalTitleText, tableHeader, tableBody = '';
        const parseWorkerDate = (dateStr) => dateStr ? new Date(dateStr) : null;

        if (type === 'machine') {
            detailData = currentFilteredData.filter(row => row.Descrip_Maquina === category);
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
                        <td>${parseWorkerDate(row.Fecha).toLocaleDateString('es-ES')}</td>
                        <td>${row.Turno || '--'}</td>
                        <td>${row.Apellido || '--'}</td>
                        <td>${isNewProd ? formatNumber(row.Cantidad) : ''}</td>
                        <td>${row.descrip_incidencia || ''}</td>
                        <td>${row.Minutos || ''}</td>
                    </tr>
                `;
            });

        } else if (type === 'downtime') {
            detailData = currentFilteredData.filter(row => row.descrip_incidencia === category);
            modalTitleText = `Detalle de Paradas por: ${category}`;
            tableHeader = `<th>Fecha</th><th>Máquina</th><th>Turno</th><th>Operario</th><th>Minutos Parada</th>`;
            
            detailData.forEach(row => {
                tableBody += `
                    <tr>
                        <td>${parseWorkerDate(row.Fecha).toLocaleDateString('es-ES')}</td>
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
        
        if (!detailData || detailData.length === 0) {
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
                        if (chartId === 'chart-prod-by-machine') {
                            const machineName = config.w.config.xaxis.categories[config.dataPointIndex];
                            showDrillDownModal(machineName, 'machine');
                        } else if (chartId === 'chart-downtime-combo') {
                            const reason = config.w.config.xaxis.categories[config.dataPointIndex];
                            showDrillDownModal(reason, 'downtime');
                        }
                    }
                },
                zoom: { enabled: false },
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
                xaxis: { categories: chartData.categories, labels: { style: { colors: textColor }}},
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
    
    // --- AI Assistant Chat Functions ---
    function initAIChat() {
        aiAssistantBtn.addEventListener('click', () => toggleChat(true));
        closeChatBtn.addEventListener('click', () => toggleChat(false));
        sendChatBtn.addEventListener('click', sendMessage);
        chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
        
        const maximizeChatBtn = document.getElementById('maximize-chat-btn');
        maximizeChatBtn.addEventListener('click', () => {
            const icon = maximizeChatBtn.querySelector('i');
            const isMaximized = chatContainer.classList.toggle('ai-chat-container-maximized');
            icon.className = isMaximized ? 'fas fa-compress' : 'fas fa-expand';
        });
    }

    function toggleChat(show) {
        chatContainer.style.display = show ? 'flex' : 'none';
        if (show) chatInput.focus();
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
        toggleOverlay(true);

        if (API_KEY === 'YOUR_API_KEY') {
            addMessage('Por favor, reemplaza YOUR_API_KEY en app.js con tu clave de API de Google AI Studio.', 'bot');
            toggleOverlay(false);
            return;
        }

        const dateRange = datepicker.selectedDates.map(d => d.toLocaleDateString('es-ES')).join(' al ');
        const selectedMachines = choicesMachine.getValue(true);
        const selectedShifts = choicesShift.getValue(true);

        const dashboardContext = `
        **Contexto Actual del Dashboard:**

        * **Filtros Activos:**
            * Rango de Fechas: ${dateRange || 'No especificado'}
            * Máquinas: ${selectedMachines.length > 0 ? selectedMachines.join(', ') : 'Todas'}
            * Turnos: ${selectedShifts.length > 0 ? selectedShifts.join(', ') : 'Todos'}

        * **KPIs Principales:**
            * Producción Total: ${formatNumber(currentKpiData.totalProduction)} pzas.
            * Disponibilidad: ${(currentKpiData.availability * 100).toFixed(1)}%
            * Eficiencia (Pzas/Turno): ${formatNumber(currentKpiData.efficiency)}
            * Horas de Parada Totales: ${currentKpiData.totalDowntimeHours.toFixed(1)} hs.
        `;

        const dataSummary = Papa.unparse(currentFilteredData.slice(0, 100));

        const prompt = `
            **Instrucciones:** Eres un asistente de IA experto en análisis de producción industrial. Sé conciso y directo.
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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();
            const botResponse = data.candidates[0].content.parts[0].text;
            addMessage(botResponse, 'bot');
        } catch (error) {
            console.error('Error en la API de Gemini:', error);
            addMessage('Hubo un error al contactar al asistente de IA.', 'bot');
        } finally {
            toggleOverlay(false);
        }
    }

    // --- START ---
    init();
});
