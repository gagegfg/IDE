document.addEventListener('DOMContentLoaded', function () {
    const CSV_URL = 'exportProduccionyEventos.csv';

    // --- STATE MANAGEMENT ---
    let charts = {};
    let choicesMachine, choicesShift, choicesMachineGroup, choicesOperator, datepicker;
    let detailModal;

    let allMachines = [];
    let allShifts = [];
    let allMachineGroups = [];
    let allOperators = [];
    let machineToGroupMap = {};
    let minDataDateStr = null;
    let maxDataDateStr = null;

    let dateMode = 'range'; // 'range' | 'single' | 'multiple'
    let machineSelectMode = 'single'; // 'single' | 'multiple'
    let selectedGroup = ''; // '' means all groups
    let selectedMachinesList = [];
    let selectedShiftsList = [];
    let selectedOperator = null;
    let isUpdatingChoices = false;

    let currentFilteredData = [];
    let fullDowntimeData = [];
    let dailyProdData = {};
    let machineSummaryData = [];

    // --- UI ELEMENTS ---
    const loadingOverlay = document.getElementById('loading-overlay');
    const progressContainer = document.getElementById('progress-container');
    const progressCircle = document.querySelector('.progress-circle');
    const progressText = document.querySelector('.progress-text');
    const progressStatusText = document.getElementById('progress-status-text');
    const themeToggle = document.getElementById('theme-toggle');
    const downtimeFilter = document.getElementById('downtime-filter');
    const clearOperatorBtn = document.getElementById('clear-operator-filter');

    const chartColors = ['#5E35B1', '#039BE5', '#00897B', '#FDD835', '#E53935', '#8E24AA', '#3949AB', '#FB8C00', '#43A047'];
    const formatNumber = (val) => (val !== null && val !== undefined && !isNaN(val)) ? Number(val).toLocaleString('es-ES', { maximumFractionDigits: 0 }) : val;

    function getLocalDateString(d) {
        if (!d) return null;
        const date = d instanceof Date ? d : new Date(d);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function parseIsoDateString(str) {
        if (!str) return new Date();
        const [y, m, d] = str.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    function shortenMachineName(name) {
        return name
            .replace(/^Budinera\s+/i, 'B. ')
            .replace(/^Pan\s*Dulcera\s+/i, 'P. Dulc. ');
    }

    // --- WEB WORKER ---
    const worker = new Worker('worker.js');

    worker.onmessage = function (e) {
        const { type, payload } = e.data;

        switch (type) {
            case 'data_loaded':
                allMachines = payload.uniqueMachines || [];
                allShifts = payload.uniqueShifts || [];
                allMachineGroups = payload.uniqueMachineGroups || [];
                allOperators = payload.uniqueOperators || [];
                machineToGroupMap = payload.machineToGroupMap || {};
                minDataDateStr = payload.minDateStr;
                maxDataDateStr = payload.maxDateStr;

                populateFilters();
                addEventListeners();

                const today = new Date();
                const startOfPreviousMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                datepicker.setDate([startOfPreviousMonth, today], true);
                document.getElementById('last-updated').textContent = `Actualizado: ${new Date().toLocaleString('es-ES')}`;
                break;

            case 'update_dashboard':
                currentFilteredData = payload.filteredData || [];
                fullDowntimeData = payload.chartsData.downtimeComboData || [];
                dailyProdData = payload.chartsData.dailyProdData || {};
                machineSummaryData = payload.chartsData.machineSummaryData || [];
                updateDashboard(payload.kpiData, payload.chartsData, payload.summaryData);
                break;

            case 'progress':
                toggleProgress(true, payload.progress, payload.status);
                break;

            case 'error':
                console.error("Error from worker:", payload);
                alert("Ocurrió un error al procesar los datos. Revisa la consola.");
                toggleProgress(false);
                toggleOverlay(false);
                break;
        }
    };

    // --- INITIALIZATION ---
    function init() {
        initTheme();
        detailModal = new bootstrap.Modal(document.getElementById('detailModal'));
        toggleOverlay(true);
        worker.postMessage({ type: 'load_data', payload: { url: `${CSV_URL}?t=${Date.now()}` } });
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

    function initDatepicker(mode, defaultDates) {
        if (datepicker) {
            datepicker.destroy();
        }
        datepicker = flatpickr("#date-range-picker", {
            mode: mode,
            dateFormat: "d/m/Y",
            conjunction: ", ",
            locale: "es",
            defaultDate: defaultDates || [],
            onChange: function (selectedDates) {
                if (mode === 'range') {
                    // Dispara cuando el rango tiene 2 fechas (o al cerrar con 1 fecha)
                    if (selectedDates.length === 2) {
                        applyFilters();
                    }
                } else {
                    applyFilters();
                }
            },
            onClose: function (selectedDates) {
                if (mode === 'range' && selectedDates.length === 1) {
                    applyFilters();
                }
            }
        });
    }

    // --- FILTER POPULATION & PILLS ---
    function populateFilters() {
        // 1. Datepicker
        initDatepicker('range', []);

        // 2. Machine Groups
        const machineGroupFilterEl = document.getElementById('machine-group-filter');
        machineGroupFilterEl.innerHTML = '';
        machineGroupFilterEl.add(new Option('Todos los grupos...', '', true, true));
        allMachineGroups.forEach(group => machineGroupFilterEl.add(new Option(group, group)));
        if (choicesMachineGroup) choicesMachineGroup.destroy();
        choicesMachineGroup = new Choices(machineGroupFilterEl, { searchEnabled: false, itemSelectText: '' });

        renderGroupPills();

        // 3. Machines
        const machineFilterEl = document.getElementById('machine-filter');
        machineFilterEl.innerHTML = '';
        allMachines.forEach(machine => machineFilterEl.add(new Option(machine, machine)));
        if (choicesMachine) choicesMachine.destroy();
        choicesMachine = new Choices(machineFilterEl, {
            removeItemButton: true,
            placeholder: true,
            placeholderValue: 'Buscar o elegir máquinas...',
            itemSelectText: ''
        });

        renderMachinePills();

        // 4. Shifts
        const shiftFilterEl = document.getElementById('shift-filter');
        shiftFilterEl.innerHTML = '';
        allShifts.forEach(shift => shiftFilterEl.add(new Option(shift, shift)));
        if (choicesShift) choicesShift.destroy();
        choicesShift = new Choices(shiftFilterEl, {
            removeItemButton: true,
            placeholder: true,
            placeholderValue: 'Todos los turnos...',
            itemSelectText: ''
        });

        renderShiftPills();

        // 5. Operators
        const operatorSelectEl = document.getElementById('operator-select');
        operatorSelectEl.innerHTML = '';
        operatorSelectEl.add(new Option('Todos los operarios...', '', true, true));
        allOperators.forEach(op => operatorSelectEl.add(new Option(op, op)));
        if (choicesOperator) choicesOperator.destroy();
        choicesOperator = new Choices(operatorSelectEl, {
            searchEnabled: true,
            itemSelectText: '',
            placeholder: true,
            placeholderValue: 'Todos los operarios...'
        });
    }

    function renderGroupPills() {
        const container = document.getElementById('group-quick-pills');
        if (!container) return;
        container.innerHTML = '';

        const allPill = document.createElement('button');
        allPill.type = 'button';
        allPill.className = `filter-pill ${selectedGroup === '' ? 'active' : ''}`;
        allPill.textContent = 'Todos';
        allPill.addEventListener('click', () => selectMachineGroup(''));
        container.appendChild(allPill);

        allMachineGroups.forEach(grp => {
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = `filter-pill ${selectedGroup === grp ? 'active' : ''}`;
            const label = grp === 'PANDULCERA MANUAL' ? 'Pand. Manual' : (grp.charAt(0) + grp.slice(1).toLowerCase());
            pill.textContent = label;
            pill.title = grp;
            pill.addEventListener('click', () => {
                selectMachineGroup(selectedGroup === grp ? '' : grp);
            });
            container.appendChild(pill);
        });
    }

    function getVisibleMachines() {
        if (!selectedGroup) return allMachines;
        return allMachines.filter(m => machineToGroupMap[m] === selectedGroup);
    }

    function renderMachinePills() {
        const container = document.getElementById('machine-quick-pills');
        if (!container) return;
        container.innerHTML = '';

        const visibleMachines = getVisibleMachines();
        visibleMachines.forEach(machine => {
            const isSelected = selectedMachinesList.includes(machine);
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = `filter-pill ${isSelected ? 'active' : ''}`;
            pill.textContent = shortenMachineName(machine);
            pill.title = `${machine} (${machineToGroupMap[machine] || ''})`;
            pill.addEventListener('click', () => handleMachinePillClick(machine));
            container.appendChild(pill);
        });
    }

    function renderShiftPills() {
        const container = document.getElementById('shift-quick-pills');
        if (!container) return;
        container.innerHTML = '';

        allShifts.forEach(shift => {
            const isSelected = selectedShiftsList.includes(shift);
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = `filter-pill ${isSelected ? 'active' : ''}`;
            pill.textContent = shift;
            pill.addEventListener('click', () => {
                if (selectedShiftsList.includes(shift)) {
                    selectedShiftsList = selectedShiftsList.filter(s => s !== shift);
                } else {
                    selectedShiftsList.push(shift);
                }
                syncShiftChoices();
                renderShiftPills();
                applyFilters();
            });
            container.appendChild(pill);
        });
    }

    function selectMachineGroup(group) {
        selectedGroup = group;
        if (choicesMachineGroup) {
            choicesMachineGroup.setChoiceByValue(group);
        }
        // Filter selectedMachinesList to only keep machines in the selected group
        if (selectedGroup) {
            selectedMachinesList = selectedMachinesList.filter(m => machineToGroupMap[m] === selectedGroup);
        }
        updateMachineChoicesOptions();
        renderGroupPills();
        renderMachinePills();
        applyFilters();
    }

    function updateMachineChoicesOptions() {
        if (!choicesMachine) return;
        isUpdatingChoices = true;
        const visibleMachines = getVisibleMachines();
        choicesMachine.clearStore();
        choicesMachine.setChoices(
            visibleMachines.map(m => ({
                value: m,
                label: m,
                selected: selectedMachinesList.includes(m)
            })),
            'value',
            'label',
            true
        );
        isUpdatingChoices = false;
    }

    function syncMachineChoices() {
        if (!choicesMachine) return;
        isUpdatingChoices = true;
        choicesMachine.removeActiveItems();
        if (selectedMachinesList.length > 0) {
            choicesMachine.setChoiceByValue(selectedMachinesList);
        }
        isUpdatingChoices = false;
    }

    function syncShiftChoices() {
        if (!choicesShift) return;
        isUpdatingChoices = true;
        choicesShift.removeActiveItems();
        if (selectedShiftsList.length > 0) {
            choicesShift.setChoiceByValue(selectedShiftsList);
        }
        isUpdatingChoices = false;
    }

    function handleMachinePillClick(machine) {
        if (machineSelectMode === 'single') {
            if (selectedMachinesList.length === 1 && selectedMachinesList[0] === machine) {
                selectedMachinesList = [];
            } else {
                selectedMachinesList = [machine];
            }
        } else {
            if (selectedMachinesList.includes(machine)) {
                selectedMachinesList = selectedMachinesList.filter(m => m !== machine);
            } else {
                selectedMachinesList.push(machine);
            }
        }
        syncMachineChoices();
        renderMachinePills();
        applyFilters();
    }

    // --- EVENT LISTENERS ---
    function addEventListeners() {
        // Date Mode Radio Switches (Rango | 1 Día | Días Sueltos)
        document.querySelectorAll('input[name="dateMode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                const newMode = e.target.value;
                const currentDates = datepicker ? datepicker.selectedDates : [];
                dateMode = newMode;

                if (newMode === 'single') {
                    const fallback = currentDates.length > 0 ? [currentDates[currentDates.length - 1]] : [parseIsoDateString(maxDataDateStr)];
                    initDatepicker('single', fallback);
                    applyFilters();
                } else if (newMode === 'multiple') {
                    const fallback = currentDates.length > 0 ? currentDates : [parseIsoDateString(maxDataDateStr)];
                    initDatepicker('multiple', fallback);
                    applyFilters();
                } else {
                    const today = new Date();
                    const startOfPrev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                    const fallback = currentDates.length >= 2 ? [currentDates[0], currentDates[currentDates.length - 1]] : [startOfPrev, today];
                    initDatepicker('range', fallback);
                    applyFilters();
                }
            });
        });

        // Machine Selection Mode (Individual vs Múltiple)
        document.querySelectorAll('input[name="machineSelectMode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                machineSelectMode = e.target.value;
                if (machineSelectMode === 'single' && selectedMachinesList.length > 1) {
                    selectedMachinesList = [selectedMachinesList[0]];
                    syncMachineChoices();
                    renderMachinePills();
                    applyFilters();
                }
            });
        });

        // Machine Choices dropdown change
        document.getElementById('machine-filter').addEventListener('change', () => {
            if (isUpdatingChoices) return;
            const vals = choicesMachine.getValue(true);
            if (machineSelectMode === 'single' && vals.length > 1) {
                selectedMachinesList = [vals[vals.length - 1]];
                syncMachineChoices();
            } else {
                selectedMachinesList = vals;
            }
            renderMachinePills();
            applyFilters();
        });

        document.getElementById('btn-all-machines').addEventListener('click', () => {
            if (selectedMachinesList.length === 0) return;
            selectedMachinesList = [];
            syncMachineChoices();
            renderMachinePills();
            applyFilters();
        });

        document.getElementById('btn-all-shifts').addEventListener('click', () => {
            if (selectedShiftsList.length === 0) return;
            selectedShiftsList = [];
            syncShiftChoices();
            renderShiftPills();
            applyFilters();
        });

        // Operator select change
        document.getElementById('operator-select').addEventListener('change', () => {
            if (isUpdatingChoices) return;
            const val = choicesOperator.getValue(true);
            selectedOperator = val || null;
            if (clearOperatorBtn) clearOperatorBtn.style.display = selectedOperator ? 'inline-block' : 'none';
            applyFilters();
        });

        if (clearOperatorBtn) {
            clearOperatorBtn.addEventListener('click', clearOperatorFilter);
        }

        // Extended analysis table toggle
        const extToggle = document.getElementById('extended-analysis-toggle');
        if (extToggle) {
            extToggle.addEventListener('change', () => {
                const sec = document.getElementById('extended-analysis-section');
                if (sec) sec.style.display = extToggle.checked ? 'block' : 'none';
            });
        }

        // Daily chart options
        document.getElementById('daily-prod-agg-options')?.addEventListener('change', applyFilters);
        document.getElementById('daily-prod-chart-type')?.addEventListener('change', rerenderDailyProdChart);
        document.getElementById('apply-yaxis-scale')?.addEventListener('click', rerenderDailyProdChart);
        document.getElementById('reset-yaxis-scale')?.addEventListener('click', () => {
            document.getElementById('yaxis-min').value = '';
            document.getElementById('yaxis-max').value = '';
            rerenderDailyProdChart();
        });

        if (downtimeFilter) {
            downtimeFilter.addEventListener('change', filterAndRenderDowntimeChart);
        }

        // Summary table search & export
        document.getElementById('summary-table-search')?.addEventListener('input', (e) => {
            renderMachineSummaryTable(machineSummaryData, e.target.value);
        });
        document.getElementById('export-summary-csv')?.addEventListener('click', exportMachineSummaryCSV);

        // Reload CSV button
        document.getElementById('btn-reload-csv')?.addEventListener('click', () => {
            toggleOverlay(true);
            worker.postMessage({ type: 'load_data', payload: { url: `${CSV_URL}?t=${Date.now()}` } });
        });

        // Quick Date Buttons
        document.getElementById('btnUltimoDia')?.addEventListener('click', () => {
            const lastDate = maxDataDateStr ? parseIsoDateString(maxDataDateStr) : new Date();
            setDateModeAndDates('single', [lastDate]);
        });

        document.getElementById('btnUltimos7Dias')?.addEventListener('click', () => {
            const end = maxDataDateStr ? parseIsoDateString(maxDataDateStr) : new Date();
            const start = new Date(end);
            start.setDate(end.getDate() - 6);
            setDateModeAndDates('range', [start, end]);
        });

        document.getElementById('btnMesActual').addEventListener('click', () => {
            const today = new Date();
            setDateModeAndDates('range', [new Date(today.getFullYear(), today.getMonth(), 1), today]);
        });

        document.getElementById('btnMesAnterior').addEventListener('click', () => {
            const today = new Date();
            const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            const end = new Date(today.getFullYear(), today.getMonth(), 0);
            setDateModeAndDates('range', [start, end]);
        });

        document.getElementById('btnSemanaActual').addEventListener('click', () => {
            const today = new Date();
            const dayOfWeek = today.getDay();
            const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
            const startOfWeek = new Date(today);
            startOfWeek.setDate(today.getDate() - diff);
            startOfWeek.setHours(0, 0, 0, 0);
            setDateModeAndDates('range', [startOfWeek, today]);
        });

        document.getElementById('btnSemanaAnterior').addEventListener('click', () => {
            const today = new Date();
            const dayOfWeek = today.getDay();
            const adjustedDay = (dayOfWeek === 0) ? 7 : dayOfWeek;
            const endOfLastWeek = new Date(today);
            endOfLastWeek.setDate(today.getDate() - adjustedDay);
            endOfLastWeek.setHours(23, 59, 59, 999);
            const startOfLastWeek = new Date(endOfLastWeek);
            startOfLastWeek.setDate(endOfLastWeek.getDate() - 6);
            startOfLastWeek.setHours(0, 0, 0, 0);
            setDateModeAndDates('range', [startOfLastWeek, endOfLastWeek]);
        });

        document.getElementById('reset-filters').addEventListener('click', resetAllFilters);
    }

    function setDateModeAndDates(mode, dates) {
        dateMode = mode;
        const radioId = mode === 'single' ? 'dateModeSingle' : (mode === 'multiple' ? 'dateModeMultiple' : 'dateModeRange');
        const radioEl = document.getElementById(radioId);
        if (radioEl) radioEl.checked = true;
        initDatepicker(mode, dates);
        applyFilters();
    }

    function resetAllFilters() {
        const today = new Date();
        const startOfPreviousMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);

        selectedGroup = '';
        selectedMachinesList = [];
        selectedShiftsList = [];
        selectedOperator = null;

        if (choicesMachineGroup) choicesMachineGroup.setChoiceByValue('');
        updateMachineChoicesOptions();
        syncShiftChoices();
        if (choicesOperator) choicesOperator.setChoiceByValue('');
        if (clearOperatorBtn) clearOperatorBtn.style.display = 'none';

        renderGroupPills();
        renderMachinePills();
        renderShiftPills();

        if (downtimeFilter) downtimeFilter.value = 'all';
        const aggTotal = document.getElementById('aggTotal');
        if (aggTotal) aggTotal.checked = true;
        const dailyTypeLine = document.getElementById('dailyTypeLine');
        if (dailyTypeLine) dailyTypeLine.checked = true;

        document.getElementById('yaxis-min').value = '';
        document.getElementById('yaxis-max').value = '';
        const searchInput = document.getElementById('summary-table-search');
        if (searchInput) searchInput.value = '';

        setDateModeAndDates('range', [startOfPreviousMonth, today]);
    }

    // --- DATA FLOW & UI UPDATES ---
    function applyOperatorFilter(operatorName) {
        if (selectedOperator === operatorName) {
            clearOperatorFilter();
            return;
        }
        selectedOperator = operatorName;
        isUpdatingChoices = true;
        if (choicesOperator) choicesOperator.setChoiceByValue(operatorName);
        isUpdatingChoices = false;
        if (clearOperatorBtn) clearOperatorBtn.style.display = 'inline-block';
        applyFilters();
    }

    function clearOperatorFilter() {
        selectedOperator = null;
        isUpdatingChoices = true;
        if (choicesOperator) choicesOperator.setChoiceByValue('');
        isUpdatingChoices = false;
        if (clearOperatorBtn) clearOperatorBtn.style.display = 'none';
        applyFilters();
    }

    function applyFilters() {
        toggleProgress(true, 5, 'Filtrando datos...');
        const dailyAggInput = document.querySelector('input[name="dailyAgg"]:checked');
        const dailyAgg = dailyAggInput ? dailyAggInput.value : 'total';

        const selectedDates = datepicker ? datepicker.selectedDates : [];
        const selectedDatesStr = selectedDates.map(d => getLocalDateString(d)).filter(Boolean);

        const filterValues = {
            dateMode: dateMode,
            dateRange: selectedDates,
            selectedDatesStr: selectedDatesStr,
            selectedMachines: selectedMachinesList,
            selectedShifts: selectedShiftsList,
            selectedMachineGroup: selectedGroup === '' ? null : selectedGroup,
            isExtended: document.getElementById('extended-analysis-toggle')?.checked || false,
            dailyAggregationType: dailyAgg,
            selectedOperator: selectedOperator
        };

        renderActiveFilterChips();
        worker.postMessage({ type: 'apply_filters', payload: filterValues });
    }

    function renderActiveFilterChips() {
        const bar = document.getElementById('active-filters-bar');
        if (!bar) return;
        bar.innerHTML = '';

        // 1. Date chip
        const dates = datepicker ? datepicker.selectedDates : [];
        if (dates.length > 0) {
            let dateText = '';
            if (dateMode === 'single') {
                dateText = `Día: ${dates[0].toLocaleDateString('es-ES')}`;
            } else if (dateMode === 'multiple') {
                dateText = dates.length <= 3
                    ? `Días (${dates.length}): ${dates.map(d => d.toLocaleDateString('es-ES')).join(', ')}`
                    : `Días sueltos: ${dates.length} seleccionados`;
            } else if (dates.length === 2) {
                dateText = `${dates[0].toLocaleDateString('es-ES')} al ${dates[1].toLocaleDateString('es-ES')}`;
            } else {
                dateText = `Día: ${dates[0].toLocaleDateString('es-ES')}`;
            }
            addChip(bar, 'fa-calendar', dateText, null);
        }

        // 2. Group chip
        if (selectedGroup) {
            addChip(bar, 'fa-layer-group', `Grupo: ${selectedGroup}`, () => selectMachineGroup(''));
        }

        // 3. Machines chips
        if (selectedMachinesList.length > 0) {
            const label = selectedMachinesList.length <= 2
                ? `Máq: ${selectedMachinesList.join(', ')}`
                : `Máquinas: ${selectedMachinesList.length} selecc.`;
            addChip(bar, 'fa-industry', label, () => {
                selectedMachinesList = [];
                syncMachineChoices();
                renderMachinePills();
                applyFilters();
            });
        }

        // 4. Shifts chip
        if (selectedShiftsList.length > 0) {
            addChip(bar, 'fa-clock', `Turno: ${selectedShiftsList.join(', ')}`, () => {
                selectedShiftsList = [];
                syncShiftChoices();
                renderShiftPills();
                applyFilters();
            });
        }

        // 5. Operator chip
        if (selectedOperator) {
            addChip(bar, 'fa-user-cog', `Operario: ${selectedOperator}`, clearOperatorFilter);
        }
    }

    function addChip(container, iconClass, text, onRemove) {
        const chip = document.createElement('span');
        chip.className = 'active-chip';
        chip.innerHTML = `<i class="fas ${iconClass}"></i><span>${text}</span>`;
        if (onRemove) {
            const closeBtn = document.createElement('span');
            closeBtn.className = 'chip-close';
            closeBtn.innerHTML = '&times;';
            closeBtn.title = 'Quitar filtro';
            closeBtn.addEventListener('click', onRemove);
            chip.appendChild(closeBtn);
        }
        container.appendChild(chip);
    }

    function rerenderDailyProdChart() {
        renderChart('chart-daily-production', 'daily', dailyProdData);
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
            if (chart && chart.updateOptions) {
                chart.updateOptions({ theme: { mode: theme }, chart: { background: 'transparent' } });
            }
        });
    }

    function updateDashboard(kpiData, chartsData, summaryData) {
        renderKPIs(kpiData);
        renderSummary(summaryData);
        updateCharts(chartsData);
        const searchVal = document.getElementById('summary-table-search')?.value || '';
        renderMachineSummaryTable(chartsData.machineSummaryData || [], searchVal);
        toggleProgress(false);
        toggleOverlay(false);
    }

    function renderKPIs(kpiData) {
        document.getElementById('kpi-total-production').textContent = formatNumber(kpiData.totalProduction);
        document.getElementById('kpi-sub-production').innerHTML =
            `<i class="fas fa-calendar-check me-1"></i>Prom. diario: <strong>${formatNumber(kpiData.dailyAverage)}</strong> pzas (${formatNumber(kpiData.totalRuns)} turnos)`;

        document.getElementById('kpi-availability').textContent = `${(kpiData.availability * 100).toFixed(1)}%`;
        document.getElementById('kpi-sub-availability').innerHTML =
            `<i class="fas fa-play-circle me-1"></i><strong>${(kpiData.totalNetProductionHours || 0).toFixed(1)} h</strong> prod. de ${(kpiData.totalPlannedHours || 0).toFixed(1)} h totales`;

        document.getElementById('kpi-efficiency').textContent = formatNumber(kpiData.efficiency);
        const pzasHora = kpiData.totalNetProductionHours > 0 ? kpiData.totalProduction / kpiData.totalNetProductionHours : 0;
        document.getElementById('kpi-sub-efficiency').innerHTML =
            `<i class="fas fa-tachometer-alt me-1"></i>Velocidad neta: <strong>${formatNumber(pzasHora)}</strong> pzas/h`;

        document.getElementById('kpi-total-downtime').textContent = `${kpiData.totalDowntimeHours.toFixed(1)} h`;
        document.getElementById('kpi-sub-downtime').innerHTML =
            `<i class="fas fa-bell me-1"></i><strong>${formatNumber(kpiData.totalDowntimeFrequency || 0)}</strong> paradas registradas`;
    }

    function renderSummary(summaryData) {
        const summaryElement = document.getElementById('management-summary');
        if (!summaryData || summaryData.topReason === 'N/A') {
            summaryElement.innerHTML = 'No hay datos suficientes para la selección de filtros actual.';
            return;
        }

        summaryElement.innerHTML = `
            Disponibilidad operativa del <strong>${summaryData.availabilityPercentage}%</strong>. 
            Principal causa de parada: "<strong>${summaryData.topReason}</strong>" (<strong>${summaryData.topReasonHours} h</strong>, <strong>${summaryData.topReasonPercentage}%</strong> del tiempo inactivo).
            Mayor producción: <strong>${summaryData.topMachine}</strong> (${formatNumber(summaryData.topMachineProd)} pzas) · 
            Mayor parada: <strong>${summaryData.worstDowntimeMachine}</strong> (${summaryData.worstDowntimeHours} h).
        `;
    }

    function updateCharts(chartsData) {
        dailyProdData = chartsData.dailyProdData || {};
        renderChart('chart-daily-production', 'daily', dailyProdData);
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
        } else if (filterValue === 'top10_time') {
            dataToRender.sort((a, b) => b.totalMinutes - a.totalMinutes);
            dataToRender = dataToRender.slice(0, 10);
        } else if (filterValue === 'top5_freq') {
            dataToRender.sort((a, b) => b.totalFrequency - a.totalFrequency);
            dataToRender = dataToRender.slice(0, 5);
        } else {
            dataToRender.sort((a, b) => b.totalMinutes - a.totalMinutes);
        }

        renderChart('chart-downtime-combo', 'combo', dataToRender);
    }

    // --- MACHINE SUMMARY TABLE (EXTENDED ANALYSIS) ---
    function renderMachineSummaryTable(data, searchQuery = '') {
        const tbody = document.getElementById('machine-summary-tbody');
        if (!tbody) return;

        const q = searchQuery.trim().toLowerCase();
        const filtered = q
            ? data.filter(m => m.machine.toLowerCase().includes(q) || m.group.toLowerCase().includes(q) || m.topReason.toLowerCase().includes(q))
            : data;

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="10" class="text-center py-3 text-muted">No hay máquinas que coincidan con la selección actual.</td></tr>`;
            return;
        }

        tbody.innerHTML = filtered.map(m => {
            const badgeColor = m.availability >= 80 ? 'bg-success' : (m.availability >= 65 ? 'bg-warning text-dark' : 'bg-danger');
            const isSelected = selectedMachinesList.includes(m.machine);
            return `
                <tr>
                    <td class="fw-semibold">${m.machine}</td>
                    <td><span class="badge bg-purple-soft text-purple">${m.group}</span></td>
                    <td class="text-end">${formatNumber(m.runs)}</td>
                    <td class="text-end fw-bold">${formatNumber(m.production)}</td>
                    <td class="text-end">${formatNumber(m.avgPerShift)}</td>
                    <td class="text-end">${m.netHours.toFixed(1)} h</td>
                    <td class="text-end text-danger fw-medium">${m.downtimeHours.toFixed(1)} h <span class="text-muted extra-small">(${m.downtimeEvents})</span></td>
                    <td>
                        <div class="d-flex align-items-center gap-2">
                            <div class="progress flex-grow-1" style="height: 7px;">
                                <div class="progress-bar ${badgeColor}" role="progressbar" style="width: ${Math.min(100, m.availability)}%"></div>
                            </div>
                            <span class="small fw-semibold" style="min-width: 42px;">${m.availability}%</span>
                        </div>
                    </td>
                    <td class="small">${m.topReason} ${m.topReasonHours > 0 ? `<span class="text-muted">(${m.topReasonHours} h)</span>` : ''}</td>
                    <td class="text-center">
                        <div class="btn-group btn-group-xs">
                            <button type="button" class="btn ${isSelected ? 'btn-primary' : 'btn-outline-primary'} btn-filter-machine" data-machine="${m.machine}" title="Filtrar solo esta máquina">
                                <i class="fas fa-filter"></i>
                            </button>
                            <button type="button" class="btn btn-outline-secondary btn-detail-machine" data-machine="${m.machine}" title="Ver tabla de turnos e incidencias">
                                <i class="fas fa-list-ul"></i> Turnos
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('.btn-filter-machine').forEach(btn => {
            btn.addEventListener('click', () => {
                const mName = btn.getAttribute('data-machine');
                handleMachinePillClick(mName);
            });
        });

        tbody.querySelectorAll('.btn-detail-machine').forEach(btn => {
            btn.addEventListener('click', () => {
                const mName = btn.getAttribute('data-machine');
                showDrillDownModal(mName, 'machine');
            });
        });
    }

    function exportMachineSummaryCSV() {
        if (!machineSummaryData || machineSummaryData.length === 0) return;
        const headers = ["Máquina", "Grupo", "Turnos", "Producción Total", "Pzas/Turno", "Hs Productivas", "Hs Parada", "Eventos Parada", "Disponibilidad (%)", "Principal Causa Parada", "Hs Principal Causa"];
        const rows = machineSummaryData.map(m => [
            `"${m.machine}"`,
            `"${m.group}"`,
            m.runs,
            m.production,
            m.avgPerShift,
            String(m.netHours).replace('.', ','),
            String(m.downtimeHours).replace('.', ','),
            m.downtimeEvents,
            String(m.availability).replace('.', ','),
            `"${m.topReason}"`,
            String(m.topReasonHours).replace('.', ',')
        ].join(';'));

        const csvContent = [headers.join(';'), ...rows].join('\n');
        const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `Resumen_Maquinas_${getLocalDateString(new Date())}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // --- DRILL-DOWN MODAL ---
    function showDrillDownModal(category, type = 'machine') {
        const modalTitle = document.getElementById('detailModalLabel');
        const modalBody = document.getElementById('detailModalBody');
        let data = [], title = '', headers = [], body = [];

        if (type === 'machine') {
            data = currentFilteredData.filter(row => row.Descrip_Maquina === category);
            title = `Detalle de Producción por Turno: ${category}`;
            headers = ["Fecha", "Turno", "Operario", "Producción", "Hs Trab (min)", "Incidencia", "Frec.", "Minutos Parada"];

            let lastId = null;
            body = [...data]
                .sort((a, b) => a.timestamp - b.timestamp || String(a.Turno).localeCompare(String(b.Turno)) || a.IdProduccion - b.IdProduccion)
                .map(row => {
                    if (row.IdProduccion && row.IdProduccion === lastId) {
                        return `<tr>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td>${row.descrip_incidencia || '-'}</td>
                            <td>${row.Frecuencia || ''}</td>
                            <td>${row.Minutos || ''}</td>
                        </tr>`;
                    } else {
                        lastId = row.IdProduccion;
                        return `<tr class="table-group-divider">
                            <td class="fw-semibold">${row.Fecha.toLocaleDateString('es-ES')}</td>
                            <td><span class="badge bg-secondary">${row.Turno || 'S/T'}</span></td>
                            <td>${row.Apellido || 'N/A'}</td>
                            <td class="fw-bold text-purple">${formatNumber(row.Cantidad)}</td>
                            <td>${row.Hs_Trab || 0}</td>
                            <td>${row.descrip_incidencia || '<span class="text-muted">Sin paradas</span>'}</td>
                            <td>${row.Frecuencia || ''}</td>
                            <td>${row.Minutos || ''}</td>
                        </tr>`;
                    }
                });

        } else if (type === 'date') {
            data = currentFilteredData.filter(row => row.dateStr === category);
            const formattedDate = data[0]?.Fecha ? data[0].Fecha.toLocaleDateString('es-ES') : category;
            title = `Detalle de Producción del Día: ${formattedDate}`;
            headers = ["Máquina", "Turno", "Operario", "Producción", "Hs Trab (min)", "Incidencia", "Frec.", "Minutos Parada"];

            let lastId = null;
            body = [...data]
                .sort((a, b) => String(a.Descrip_Maquina).localeCompare(String(b.Descrip_Maquina), 'es', { numeric: true }) || String(a.Turno).localeCompare(String(b.Turno)) || a.IdProduccion - b.IdProduccion)
                .map(row => {
                    if (row.IdProduccion && row.IdProduccion === lastId) {
                        return `<tr>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td>${row.descrip_incidencia || '-'}</td>
                            <td>${row.Frecuencia || ''}</td>
                            <td>${row.Minutos || ''}</td>
                        </tr>`;
                    } else {
                        lastId = row.IdProduccion;
                        return `<tr class="table-group-divider">
                            <td class="fw-semibold">${row.Descrip_Maquina}</td>
                            <td><span class="badge bg-secondary">${row.Turno || 'S/T'}</span></td>
                            <td>${row.Apellido || 'N/A'}</td>
                            <td class="fw-bold text-purple">${formatNumber(row.Cantidad)}</td>
                            <td>${row.Hs_Trab || 0}</td>
                            <td>${row.descrip_incidencia || '<span class="text-muted">Sin paradas</span>'}</td>
                            <td>${row.Frecuencia || ''}</td>
                            <td>${row.Minutos || ''}</td>
                        </tr>`;
                    }
                });

        } else if (type === 'downtime') {
            data = currentFilteredData.filter(row => row.descrip_incidencia === category && row.Minutos > 0);
            title = `Detalle de Paradas por: ${category}`;
            headers = ["Fecha", "Máquina", "Turno", "Operario", "Frecuencia", "Minutos Parada"];
            body = [...data]
                .sort((a, b) => a.timestamp - b.timestamp || String(a.Turno).localeCompare(String(b.Turno)))
                .map(row => `<tr>
                    <td>${row.Fecha.toLocaleDateString('es-ES')}</td>
                    <td class="fw-semibold">${row.Descrip_Maquina}</td>
                    <td><span class="badge bg-secondary">${row.Turno || 'S/T'}</span></td>
                    <td>${row.Apellido || 'N/A'}</td>
                    <td>${row.Frecuencia || 1}</td>
                    <td class="fw-bold text-danger">${row.Minutos} min</td>
                </tr>`);
        }

        modalTitle.textContent = title;
        if (data.length > 0) {
            modalBody.innerHTML = `
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <span class="text-muted small">Mostrando <strong>${data.length}</strong> registros encontrados</span>
                    <div>
                        <button id="export-pdf" class="btn btn-sm btn-danger me-2"><i class="fas fa-file-pdf me-1"></i>Exportar a PDF</button>
                        <button id="export-excel" class="btn btn-sm btn-success"><i class="fas fa-file-excel me-1"></i>Exportar a Excel</button>
                    </div>
                </div>
                <div class="table-responsive modal-table-container">
                    <table class="table table-hover table-sm align-middle">
                        <thead class="table-dark"><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
                        <tbody>${body.join('')}</tbody>
                    </table>
                </div>`;

            document.getElementById('export-pdf').addEventListener('click', () => exportToPDF(data, headers, title, type));
            document.getElementById('export-excel').addEventListener('click', () => exportToExcel(data, headers, title, type));
        } else {
            modalBody.innerHTML = '<p class="text-center my-4">No hay datos detallados para la selección actual.</p>';
        }

        detailModal.show();
    }

    function exportToPDF(data, headers, title, type) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();

        const tableData = data.map(row => {
            if (type === 'machine') {
                return [row.Fecha.toLocaleDateString('es-ES'), row.Turno, row.Apellido || 'N/A', formatNumber(row.Cantidad), row.Hs_Trab || 0, row.descrip_incidencia || '', row.Frecuencia || '', row.Minutos || ''];
            } else if (type === 'date') {
                return [row.Descrip_Maquina, row.Turno, row.Apellido || 'N/A', formatNumber(row.Cantidad), row.Hs_Trab || 0, row.descrip_incidencia || '', row.Frecuencia || '', row.Minutos || ''];
            } else {
                return [row.Fecha.toLocaleDateString('es-ES'), row.Descrip_Maquina, row.Turno, row.Apellido || 'N/A', row.Frecuencia || 1, row.Minutos];
            }
        });

        doc.autoTable({
            head: [headers],
            body: tableData,
            didDrawPage: function (d) {
                doc.text(title, d.settings.margin.left, 15);
            }
        });

        doc.save(`${title.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`);
    }

    function exportToExcel(data, headers, title, type) {
        const csvContent = [headers.join(';'), ...data.map(row => {
            if (type === 'machine') {
                return [row.Fecha.toLocaleDateString('es-ES'), row.Turno, row.Apellido || 'N/A', row.Cantidad, row.Hs_Trab || 0, `"${row.descrip_incidencia || ''}"`, row.Frecuencia || '', row.Minutos || ''].join(';');
            } else if (type === 'date') {
                return [`"${row.Descrip_Maquina}"`, row.Turno, row.Apellido || 'N/A', row.Cantidad, row.Hs_Trab || 0, `"${row.descrip_incidencia || ''}"`, row.Frecuencia || '', row.Minutos || ''].join(';');
            } else {
                return [row.Fecha.toLocaleDateString('es-ES'), `"${row.Descrip_Maquina}"`, row.Turno, row.Apellido || 'N/A', row.Frecuencia || 1, row.Minutos].join(';');
            }
        })].join('\n');

        const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `${title.replace(/[^a-zA-Z0-9_-]/g, "_")}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // --- CHART RENDERING ---
    function renderChart(elementId, type, chartData) {
        if (!chartData) return;
        const currentTheme = localStorage.getItem('dashboardTheme') || 'light';
        const textColor = currentTheme === 'dark' ? '#e2e8f0' : '#334155';
        const gridBorderColor = currentTheme === 'dark' ? '#334155' : '#e2e8f0';

        const commonOptions = {
            chart: {
                height: 350,
                fontFamily: 'Inter, sans-serif',
                toolbar: { show: true },
                background: 'transparent',
                animations: { enabled: true, speed: 350 },
                events: {
                    dataPointSelection: function (event, chartContext, config) {
                        const chartId = config.w.config.chart.id;
                        if (config.dataPointIndex < 0) return;

                        if (chartId === 'chart-daily-production') {
                            const dateStr = dailyProdData.dateStrings?.[config.dataPointIndex];
                            if (dateStr) showDrillDownModal(dateStr, 'date');
                            return;
                        }

                        if (!config.w.config.xaxis.categories) return;
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
                            download: 'Descargar SVG/PNG',
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
        if (type === 'daily') {
            const dailyAgg = document.querySelector('input[name="dailyAgg"]:checked')?.value || 'total';
            const dailyChartType = document.querySelector('input[name="dailyChartType"]:checked')?.value || 'line';
            const showLabels = (dailyAgg === 'total');

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

            // If multiple non-consecutive days are selected or bar chart is selected, use formatted date categories so gaps don't distort bars
            const useCategoryAxis = dateMode === 'multiple' || dailyChartType === 'bar';
            const xCategories = useCategoryAxis
                ? (chartData.dateStrings || []).map(ds => {
                    const [y, m, d] = ds.split('-');
                    return `${d}/${m}`;
                })
                : chartData.categories;

            options = {
                ...commonOptions,
                chart: { ...commonOptions.chart, id: elementId, type: dailyChartType },
                series: chartData.series || [],
                stroke: { curve: 'smooth', width: dailyChartType === 'bar' ? 0 : 3 },
                markers: { size: dailyChartType === 'bar' ? 0 : 5 },
                plotOptions: {
                    bar: { borderRadius: 4, columnWidth: '60%' }
                },
                dataLabels: {
                    enabled: showLabels,
                    offsetY: dailyChartType === 'bar' ? -18 : -12,
                    formatter: (val) => (val === null || val === undefined) ? '' : formatNumber(val),
                    style: { colors: ["#0f172a"], fontSize: '11px', fontWeight: 600 },
                    background: {
                        enabled: true,
                        foreColor: '#0f172a',
                        borderRadius: 4,
                        padding: 4,
                        opacity: 0.92,
                        borderColor: '#BDE5F8',
                        backgroundColor: '#BDE5F8'
                    }
                },
                xaxis: useCategoryAxis
                    ? { type: 'category', categories: xCategories, labels: { style: { colors: textColor } } }
                    : { type: 'datetime', categories: xCategories, labels: { style: { colors: textColor }, datetimeUTC: false, format: 'dd MMM' } },
                yaxis: yAxisConfig,
                tooltip: {
                    theme: currentTheme,
                    x: useCategoryAxis ? {} : { format: 'dddd dd/MM/yyyy' },
                    y: { formatter: (val) => `${formatNumber(val)} pzas.` }
                }
            };
        } else if (type === 'bar') {
            const isOpChart = elementId === 'chart-prod-by-operator';
            const dynamicHeight = chartData.horizontal ? Math.max(350, (chartData.data?.length || 1) * 32) : 350;
            options = {
                ...commonOptions,
                chart: { ...commonOptions.chart, id: elementId, type: 'bar', height: dynamicHeight },
                series: [{ name: chartData.seriesName, data: (chartData.data || []).map(d => Math.round(d.value)) }],
                plotOptions: { bar: { horizontal: chartData.horizontal || false, borderRadius: 4, dataLabels: { position: 'top' } } },
                dataLabels: {
                    enabled: true,
                    formatter: (val) => formatNumber(val),
                    style: { fontSize: '11px' },
                    offsetY: chartData.horizontal ? 0 : -20,
                    dropShadow: { enabled: true, top: 1, left: 1, blur: 1, color: '#000', opacity: 0.35 }
                },
                xaxis: { categories: (chartData.data || []).map(d => d.category), labels: { style: { colors: textColor, fontSize: '11px' }, trim: true, maxHeight: 100 } },
                yaxis: { labels: { style: { colors: textColor }, formatter: (val) => typeof val === 'number' ? formatNumber(val) : val } },
                tooltip: {
                    theme: currentTheme,
                    y: {
                        formatter: (val, { dataPointIndex }) => {
                            if (isOpChart && chartData.data?.[dataPointIndex]) {
                                const item = chartData.data[dataPointIndex];
                                return `${formatNumber(val)} pzas/turno (Total: ${formatNumber(item.total)} en ${item.runs} turnos)`;
                            }
                            return `${formatNumber(val)} pzas.`;
                        }
                    }
                }
            };
            if (chartData.horizontal) {
                options.dataLabels.style.colors = ["#fff"];
                options.dataLabels.offsetX = -10;
            } else {
                options.dataLabels.style.colors = [textColor];
            }
        } else if (type === 'combo') {
            options = {
                ...commonOptions,
                chart: { ...commonOptions.chart, id: elementId, type: 'line', stacked: false },
                series: [
                    { name: 'Tiempo (Horas)', type: 'column', data: chartData.map(d => parseFloat((d.totalMinutes / 60).toFixed(1))) },
                    { name: 'Frecuencia (Eventos)', type: 'line', data: chartData.map(d => d.totalFrequency) }
                ],
                stroke: { width: [0, 4], curve: 'smooth' },
                plotOptions: { column: { borderRadius: 4 } },
                xaxis: { categories: chartData.map(d => d.reason), labels: { style: { colors: textColor, fontSize: '11px' }, trim: true, rotate: -35, hideOverlappingLabels: false, maxHeight: 120 } },
                yaxis: [
                    { seriesName: 'Tiempo (Horas)', axisTicks: { show: true }, axisBorder: { show: true, color: chartColors[0] }, labels: { style: { colors: chartColors[0] }, formatter: (val) => val.toFixed(1) }, title: { text: "Tiempo Total (Horas)", style: { color: chartColors[0] } } },
                    { seriesName: 'Frecuencia (Eventos)', opposite: true, axisTicks: { show: true }, axisBorder: { show: true, color: chartColors[1] }, labels: { style: { colors: chartColors[1] }, formatter: (val) => formatNumber(val) }, title: { text: "Frecuencia (Nro. de Veces)", style: { color: chartColors[1] } } }
                ],
                tooltip: {
                    theme: currentTheme,
                    y: {
                        formatter: function (val, { seriesIndex }) {
                            if (val === undefined) return val;
                            return seriesIndex === 0
                                ? `${val.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Hs`
                                : `${val.toLocaleString('es-ES')} eventos`;
                        }
                    }
                },
                legend: { horizontalAlign: 'left', offsetX: 40 }
            };
        } else if (type === 'stackedBar') {
            const useCategoryAxis = dateMode === 'multiple';
            const xCategories = useCategoryAxis
                ? (chartData.dateStrings || []).map(ds => {
                    const [y, m, d] = ds.split('-');
                    return `${d}/${m}`;
                })
                : chartData.categories;

            options = {
                ...commonOptions,
                chart: { ...commonOptions.chart, id: elementId, type: 'bar', stacked: true },
                plotOptions: {
                    bar: {
                        horizontal: false,
                        dataLabels: {
                            enabled: true,
                            formatter: (val) => val < 0.5 ? '' : val.toFixed(1),
                            style: { colors: ['#fff'], fontSize: '10px', fontWeight: 500 },
                            offsetY: 2
                        }
                    }
                },
                series: chartData.series || [],
                xaxis: useCategoryAxis
                    ? { type: 'category', categories: xCategories, labels: { style: { colors: textColor } } }
                    : { type: 'datetime', categories: xCategories, labels: { style: { colors: textColor }, datetimeUTC: false, format: 'dd MMM' } },
                yaxis: { title: { text: 'Horas', style: { color: textColor } }, labels: { style: { colors: textColor }, formatter: (val) => val.toFixed(0) } },
                tooltip: { y: { formatter: (val) => `${val.toFixed(1)} horas` } },
                legend: { position: 'top', horizontalAlign: 'left' }
            };
        }

        if (charts[elementId]) {
            charts[elementId].destroy();
        }
        charts[elementId] = new ApexCharts(document.querySelector(`#${elementId}`), options);
        charts[elementId].render().then(() => {
            const chartEl = document.querySelector(`#${elementId}`);
            if (chartEl && !chartEl.dataset.wheelBound) {
                chartEl.dataset.wheelBound = 'true';
                chartEl.addEventListener('wheel', (event) => {
                    if (event.ctrlKey && charts[elementId]) {
                        event.preventDefault();
                        charts[elementId][event.deltaY < 0 ? 'zoomIn' : 'zoomOut']();
                    }
                });
            }
        });
    }

    // --- START ---
    init();
});
