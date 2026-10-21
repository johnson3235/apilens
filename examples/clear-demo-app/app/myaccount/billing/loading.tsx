export default function Loading() {
  return (
    <>
      <div className="hero">
        <div>
          <p className="eyebrow">Dashboard / Billing</p>
          <h1>Billing</h1>
          <p className="muted">Loading your billing details…</p>
        </div>
      </div>
      <div className="grid two">
        {['Amount due', 'Next bill'].map((title) => (
          <section className="card" key={title} aria-busy="true">
            <h2 className="card-title">{title}</h2>
            <div className="loading" role="status">
              <div className="skeleton wide" />
              <div className="skeleton" />
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
