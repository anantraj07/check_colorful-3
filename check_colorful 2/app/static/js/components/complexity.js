import {charts,destroy,CHART_TEXT,CHART_MUTED,CHART_GRID,fmt,observations,text} from '../visuals.js?v=20261014-gaussian-contours';

const contourModes = new Map();
const dataByChart = new Map();
const contourColors = ['#7c3aed', '#2563eb', '#0f766e', '#b45309', '#9a3412', '#be185d'];
const legendFmt = value => value == null ? '—' : Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function contourMode(prefix, key) {
    const select = document.getElementById(prefix + 'ContourMode');
    if (!select) return 'none';
    if (!contourModes.has(key)) contourModes.set(key, select.value || 'none');
    select.value = contourModes.get(key);
    select.onchange = () => {
        contourModes.set(key, select.value);
        if (dataByChart.has(key)) render(dataByChart.get(key), { prefix, key });
    };
    return select.value;
}

function contourDatasets(contours) {
    return (contours || []).flatMap((contour, contourIndex) =>
        contour.lines.map(line => ({
            type: 'line',
            label: `Fitted mean disposal: ${contour.label} (${fmt(contour.value)} working days)`,
            isDisposalContour: true,
            contourPeriod: contour.label,
            contourWorkingDays: contour.value,
            data: line,
            borderColor: contourColors[contourIndex % contourColors.length],
            borderDash: [6, 4],
            borderWidth: 1.8,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHitRadius: 16,
            fill: false,
            tension: 0,
            spanGaps: false,
            order: 0,
        })),
    );
}

const labels = {
    id: 'bubbleCaseLabels',
    afterDatasetsDraw(chart) {
        const { ctx } = chart;
        chart.data.datasets.forEach((dataset, index) => {
            const meta = chart.getDatasetMeta(index);
            if (meta.hidden) return;
            ctx.save();
            ctx.font = dataset.type === 'line' ? '600 11px -apple-system, sans-serif' : '600 12px -apple-system, sans-serif';
            ctx.fillStyle = dataset.type === 'line' ? 'rgba(107,79,58,0.8)' : CHART_TEXT;
            ctx.textBaseline = 'middle';
            if (dataset.type !== 'line') {
                meta.data.forEach((point, dataIndex) => {
                    const raw = dataset.data[dataIndex];
                    ctx.textAlign = 'left';
                    ctx.fillText(raw.label, point.x + (raw.r || 10) + 6, point.y);
                });
            }
            ctx.restore();
        });
    },
};

export function render(d, { prefix = 'complexity', key = 'complexity' } = {}) {
    destroy(key);
    dataByChart.set(key, d);
    const mode = contourMode(prefix, key);
    const overlays = mode === 'empirical' ? contourDatasets(d.contours) : [];
    const subtitle = d.points.length
        ? 'Each bubble is a case type at this court. Position shows mean hearing count and service rate. Bubble size shows throughput. Colour shows observed mean time to disposal.'
        : 'Not enough eligible hearing, rate and disposal observations in this selection.';
    text(prefix + 'Subtitle', subtitle);

    const status = document.getElementById(prefix + 'ContourStatus');
    const legend = document.getElementById(prefix + 'ContourLegend');
    if (legend) {
        legend.innerHTML = mode === 'empirical'
            ? d.contours.filter(contour => contour.lines.length).map(contour => {
                const index = d.contours.indexOf(contour);
                return `<span style="color:${contourColors[index % contourColors.length]}"><i aria-hidden="true"></i>${contour.label}</span>`;
            }).join('')
            : '';
    }
    if (status) {
        const visibleContours = d.contours.filter(contour => contour.lines.length);
        const missingContours = d.contours.filter(contour => !contour.lines.length);
        status.textContent = mode !== 'empirical'
            ? 'No contour curves are drawn in this view.'
            : d.contours.length
                ? `Curves shown: ${visibleContours.map(contour => `${contour.label} (${fmt(contour.value)} working days)`).join(', ') || 'none'}.${missingContours.length ? ` No visible curve for: ${missingContours.map(contour => contour.label).join(', ')}.` : ''} A Gaussian distance weight is multiplied by each case type's disposed-case count; smoothing width is 16% of the observed range, with a 2.5% chart-axis minimum. Month/year labels use 21 working days per month.`
                : 'A fitted surface is unavailable: at least four eligible case types with disposal observations are required.';
    }

    charts[key] = new Chart(document.getElementById(prefix + 'Chart'), {
        type: 'bubble',
        data: {
            datasets: [
                {
                    label: 'Case types', data: d.points,
                    backgroundColor: d.points.map(point => point.backgroundColor),
                    borderColor: 'rgba(41,37,33,0.35)', borderWidth: 1, order: 1,
                },
                ...overlays,
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    filter: item => item.dataset.type !== 'line' || item.dataset.isDisposalContour,
                    callbacks: {
                        label: context => context.dataset.isDisposalContour
                            ? [
                                `Contour period: ${context.dataset.contourPeriod} (${fmt(context.dataset.contourWorkingDays)} working days)`,
                                `Mean hearings per disposed case (X): ${fmt(context.raw.x)}`,
                                `Mean hearings per case-month (S): ${fmt(context.raw.y)}`,
                            ]
                            : [
                                context.raw.label,
                                `Mean hearings/case: ${fmt(context.raw.x)}`,
                                `Service rate: ${fmt(context.raw.y)} hearings/case-month`,
                                `Throughput: ${fmt(context.raw.throughput)} hearings/working day`,
                                `Mean disposal: ${fmt(context.raw.disposalMean)} working days`,
                            ],
                    },
                },
            },
            scales: {
                x: {
                    min: 0, max: d.max_x,
                    title: { display: true, text: 'Mean hearings per disposed case (Complexity, X)' },
                    ticks: { color: CHART_MUTED }, grid: { color: CHART_GRID },
                },
                y: {
                    min: 0, max: d.max_y,
                    title: { display: true, text: 'Mean hearings per case-month (Service rate, S)' },
                    ticks: { color: CHART_MUTED }, grid: { color: CHART_GRID },
                },
            },
        },
        plugins: [labels],
    });

    document.getElementById(prefix + 'ColorLabels').innerHTML = d.color_labels.map(value => `<span>${legendFmt(value)} wd</span>`).join('');
    document.getElementById(prefix + 'BubbleLegend').innerHTML = d.bubbles.map(bubble =>
        `<div class="bubble-sample"><div class="bubble-sample-circle" style="width:${bubble.radius * 2}px;height:${bubble.radius * 2}px"></div><div class="bubble-sample-label">${fmt(bubble.value)}</div></div>`,
    ).join('');
    observations(prefix + 'TakeawaysList', d.observations);
}
