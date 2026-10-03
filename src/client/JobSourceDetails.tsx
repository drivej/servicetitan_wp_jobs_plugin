// Reserved for a future admin view. Do not mount without an admin access check.
interface JobSourceDetailsProps {
  details: {
    job: Record<string, unknown>;
    history: Array<{ id: string; type: string; date: string; content: string; promptEligible: boolean }>;
  };
}
interface DetailField { name: string; value: string; }

export function JobSourceDetails({ details }: JobSourceDetailsProps) {
  const fields = flattenFields(details.job);
  return (
    <>
      <section className="panel details-panel history-panel" aria-labelledby="history-heading">
        <div className="details-section-heading">
          <div>
            <p className="eyebrow">SEO source material</p>
            <h2 id="history-heading">Job history</h2>
          </div>
        </div>
        <p className="field-help">Events and relevant notes are shown oldest first for reference. They are not included in the AI prompt. Attachments are omitted.</p>
        {details.history.length === 0 ? (
          <div className="history-empty">No descriptive history entries are available for reference.</div>
        ) : (
          <div className="history-list">
            {details.history.map((item) => (
              <article className={`history-item${item.promptEligible ? '' : ' prompt-ineligible'}`} key={item.id}>
                <span className="history-item-body">
                  <span className="history-item-meta">
                    <strong>{item.type}</strong>
                    <time dateTime={item.date}>{formatHistoryDate(item.date)}</time>
                  </span>
                  <span className="history-item-content">{item.content}</span>
                  {!item.promptEligible && <span className="history-item-exclusion">Timeline only — no descriptive memo</span>}
                </span>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel details-panel" aria-labelledby="fields-heading">
        <p className="eyebrow">Individual job response</p>
        <h2 id="fields-heading">ServiceTitan fields</h2>
        <div className="details-table-wrap">
          <table className="details-table">
            <thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead>
            <tbody>{fields.map((field) => <tr key={field.name}><th scope="row">{field.name}</th><td>{field.value}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </>
  );
}

const flattenFields = (value: unknown, prefix = ''): DetailField[] => {
  if (value === null || value === undefined) return prefix ? [{ name: prefix, value: '—' }] : [];
  if (Array.isArray(value)) {
    if (value.length === 0) return prefix ? [{ name: prefix, value: '[]' }] : [];
    return value.flatMap((item, index) => flattenFields(item, `${prefix}[${index}]`));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return prefix ? [{ name: prefix, value: '{}' }] : [];
    return entries.flatMap(([key, item]) => flattenFields(item, prefix ? `${prefix}.${key}` : key));
  }
  return [{ name: prefix || 'value', value: typeof value === 'string' ? value || '—' : String(value) }];
};

const formatHistoryDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? 'Date unavailable'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};

