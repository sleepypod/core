import { useEffect, useId, useRef, useState } from 'react'
import { reportBlocks, reportExperiment, reportInline, type ReportBlock } from '@/src/reports/document'
import { morningTakeaways, reportEvidenceTitles, verifiedReportComparison, type SavedMorningReport } from '@/src/reports/morning'

const providerNames = { apple: 'Apple on-device', openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Anthropic', ollama: 'Local server' }
export const reportDate = (instant: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(instant)
const duration = (minutes: number) => `${Math.floor(Math.round(minutes) / 60)}h ${Math.round(minutes) % 60}m`
const dayLabel = (instant: number, timeZone: string) => new Intl.DateTimeFormat(undefined, { timeZone, month: 'short', day: 'numeric' }).format(instant)

function Inline({ text }: { text: string }) {
  return reportInline(text).map((run, index) => run.kind === 'strong'
    ? <strong key={index}>{run.text}</strong>
    : run.kind === 'emphasis' ? <em key={index}>{run.text}</em> : run.kind === 'code' ? <code key={index}>{run.text}</code> : run.text)
}

/** Only supplied, recognized facts become expandable source badges. Unknown references remain literal text. */
export function ReportProse({ blocks, facts }: { blocks: ReportBlock[], facts: SavedMorningReport['facts'] }) {
  return (
    <div className="report-prose">
      {blocks.map((block, index) => (
        <div className="report-block" key={index}>
          {block.kind === 'heading'
            ? <h4><Inline text={block.text} /></h4>
            : block.kind === 'code'
              ? <pre><code>{block.text}</code></pre>
              : block.kind === 'table'
                ? (
                    <div className="report-table-scroll" tabIndex={0} role="region" aria-label="Report table">
                      <table>
                        <thead><tr>{block.cells?.[0].map((cell, column) => <th scope="col" key={column}><Inline text={cell} /></th>)}</tr></thead>
                        <tbody>{block.cells?.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column}><Inline text={cell} /></td>)}</tr>)}</tbody>
                      </table>
                    </div>
                  )
                : block.kind === 'bullet'
                  ? (
                      <p className="report-bullet">
                        <span aria-hidden>{block.marker}</span>
                        <span><Inline text={block.text} /></span>
                      </p>
                    )
                  : block.kind === 'quote' ? <blockquote><Inline text={block.text} /></blockquote> : <p><Inline text={block.text} /></p>}
          {block.evidence.length > 0 && (
            <div className="report-sources">
              {block.evidence.map(identifier => (
                <details key={identifier} className="report-evidence">
                  <summary>{reportEvidenceTitles[identifier]}</summary>
                  <p>{facts.find(fact => fact.id === identifier)?.text}</p>
                </details>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** Match SVG units to its rendered width so informational labels never shrink on phones. */
function ReportComparisonPlot({ comparison }: { comparison: NonNullable<ReturnType<typeof verifiedReportComparison>> }) {
  const chartRef = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const measure = () => {
      const measuredWidth = chart.getBoundingClientRect().width
      if (measuredWidth > 0) setWidth(measuredWidth)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(chart)
    return () => observer.disconnect()
  }, [])
  const upperHours = Math.max(10, Math.ceil(Math.max(...comparison.days.map(day => (day.minutes ?? 0) / 60))))
  const columnWidth = (width - 44) / comparison.days.length
  const barWidth = Math.min(25, columnWidth * 0.64)
  return (
    <svg ref={chartRef} viewBox={`0 0 ${width} 200`} role="img" aria-label="Fourteen-day recorded sleep comparison. Blank days are unknown. Read each recorded day below for the values.">
      {[0, upperHours / 2, upperHours].map(value => (
        <g key={value}>
          <line x1="38" x2={width - 6} y1={170 - value / upperHours * 144} y2={170 - value / upperHours * 144} className="report-chart-grid" />
          <text x="27" y={174 - value / upperHours * 144} textAnchor="end">{value}</text>
        </g>
      ))}
      {comparison.days.map((day, index) => day.minutes === null
        ? null
        : (
            <rect key={day.start} x={38 + index * columnWidth + (columnWidth - barWidth) / 2} width={barWidth} y={170 - day.minutes / 60 / upperHours * 144} height={day.minutes / 60 / upperHours * 144} rx="3" className="report-chart-bar">
              <title>
                {dayLabel(day.end, comparison.timeZone)}
                :
                {' '}
                {duration(day.minutes)}
                {' '}
                recorded
              </title>
            </rect>
          ))}
      {[0, 6, 13].map(index => (
        <text key={index} x={index === 0 ? 38 : index === 13 ? width - 6 : 38 + (index + 0.5) * columnWidth} y="194" textAnchor={index === 0 ? 'start' : index === 13 ? 'end' : 'middle'}>
          {dayLabel(comparison.days[index].end, comparison.timeZone)}
        </text>
      ))}
    </svg>
  )
}

export function ReportReading({ report, compact = false }: { report: SavedMorningReport, compact?: boolean }) {
  const chartID = useId()
  const comparison = verifiedReportComparison(report)
  const takeaways = morningTakeaways(report)
  const blocks = reportBlocks(report.text, report.facts), experiment = reportExperiment(blocks)
  return (
    <div className="report-reading">
      <div className="report-introduction">
        <p>
          Evidence saved
          {' '}
          {reportDate(report.createdAt)}
        </p>
        <p className="report-muted">This brief describes that report’s evidence. It is not a new analysis of last night.</p>
        <div className="report-badges">
          <span>{report.source}</span>
          <span>
            {providerNames[report.provider]}
            {' '}
            ·
            {' '}
            {report.model}
          </span>
        </div>
      </div>
      <div className="report-takeaways">
        {takeaways.map(takeaway => (
          <section key={takeaway.id}>
            <h3>{takeaway.title}</h3>
            <span className="report-badge">{takeaway.badge}</span>
            <p>{takeaway.text}</p>
          </section>
        ))}
        {!takeaways.length && <p>This saved report has no calculated highlights. Read its original interpretation below.</p>}
      </div>
      {comparison
        ? (
            <section className="report-comparison" aria-labelledby={chartID}>
              <h3 id={chartID}>Recorded sleep · hours</h3>
              <p className="report-muted">{comparison.sourceName}</p>
              <ReportComparisonPlot comparison={comparison} />
              <p className="report-muted">
                Blank days are unknown, not zero. Sleep days run noon to noon in
                {' '}
                {comparison.timeZone}
                . Naps and partial recordings can be included.
              </p>
              {!compact && (
                <>
                  <p className="report-muted">
                    Health imported
                    {' '}
                    {reportDate(comparison.importedAt)}
                    . The chart was frozen when this report was requested.
                  </p>
                  {comparison.omittedRecords > 0 && (
                    <p className="report-muted">
                      {comparison.omittedRecords}
                      {' '}
                      invalid or ambiguous records were excluded from this comparison.
                    </p>
                  )}
                  <details>
                    <summary>Read each recorded day</summary>
                    <dl className="report-days">
                      {comparison.days.map(day => (
                        <div key={day.start}>
                          <dt>{dayLabel(day.end, comparison.timeZone)}</dt>
                          <dd>{day.minutes === null ? 'Unknown' : duration(day.minutes)}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                </>
              )}
            </section>
          )
        : (
            <p className="report-muted">
              {report.comparison === undefined ? 'This report has no saved chart data.' : 'The saved chart data could not be validated.'}
              {' '}
              Its original facts remain available below. A chart has not been reconstructed from prose.
            </p>
          )}
      {!compact && (
        <>
          <section className="report-experiment">
            <h3>An experiment from this report</h3>
            {experiment
              ? (
                  <>
                    <p className="report-badge">AI suggestion · not started</p>
                    <ReportProse blocks={experiment} facts={report.facts} />
                    <p className="report-muted">Review this suggestion before trying it. No temperature, alarm or automation is changed here.</p>
                  </>
                )
              : <p>No separate experiment is available in this saved report. Its full interpretation is below.</p>}
          </section>
          <details className="report-interpretation">
            <summary>Full interpretation and evidence</summary>
            <ReportProse blocks={blocks} facts={report.facts} />
            <details>
              <summary>
                All calculated facts (
                {report.facts.length}
                )
              </summary>
              <dl className="report-facts">
                {report.facts.map(fact => (
                  <div key={fact.id}>
                    <dt>{reportEvidenceTitles[fact.id] ?? fact.id}</dt>
                    <dd>{fact.text}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </details>
          <section className="report-answers">
            <h3>Saved answers</h3>
            {!report.followUps?.length && <p>No follow-up answers have been shared with this report.</p>}
            {report.followUps?.map(answer => (
              <div className="report-answer" key={answer.id}>
                <h4>{answer.question}</h4>
                <p className="report-muted">
                  {providerNames[answer.provider]}
                  {' '}
                  ·
                  {' '}
                  {answer.model}
                  {' '}
                  ·
                  {' '}
                  {reportDate(answer.createdAt)}
                </p>
                <ReportProse blocks={reportBlocks(answer.text, report.facts)} facts={report.facts} />
              </div>
            ))}
            <p className="report-muted">Answers use this report’s saved facts. Reading this page does not call an AI provider.</p>
          </section>
        </>
      )}
    </div>
  )
}
