const GYMS = {
  planet: {
    name: 'Planet Fitness Home Club',
    line1: '123 Demo Fitness Way',
    city: 'Hampton',
    state: 'NH',
    postal_code: '03842',
    countryCode: 'US',
  },
  lafitness: {
    name: 'LA Fitness Member Services',
    line1: '2600 Michelson Drive',
    city: 'Irvine',
    state: 'CA',
    postal_code: '92612',
    countryCode: 'US',
  },
  anytime: {
    name: 'Anytime Fitness Home Club',
    line1: '456 Sample Club Road',
    city: 'Woodbury',
    state: 'MN',
    postal_code: '55125',
    countryCode: 'US',
  },
}

const DEFAULT_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url)
      const routePath = stripBasePath(url.pathname, env)

      if (request.method === 'HEAD' && routePath === '/') {
        return new Response(null, {
          status: 200,
          headers: DEFAULT_HEADERS,
        })
      }

      if (request.method === 'GET' && routePath === '/') {
        return html(renderHome(url, env), 200)
      }

      if (request.method === 'GET' && routePath === '/success') {
        return html(renderSuccess(url, env), 200)
      }

      if (request.method === 'GET' && routePath === '/cancel') {
        return html(renderCancel(env), 200)
      }

      if (request.method === 'POST' && routePath === '/api/checkout') {
        return json(await createCheckoutSession(request, env))
      }

      if (request.method === 'GET' && routePath === '/api/fulfill') {
        const sessionId = url.searchParams.get('session_id')
        if (!sessionId) return json({ ok: false, error: 'missing_session_id' }, 400)
        return json(await fulfillCancellation(sessionId, env, url.origin))
      }

      return html(renderNotFound(), 404)
    } catch (error) {
      return json(
        {
          ok: false,
          error: 'request_failed',
          message: error instanceof Error ? error.message : String(error),
        },
        500
      )
    }
  },
}

async function createCheckoutSession(request, env) {
  assertEnv(env, 'STRIPE_SECRET_KEY')

  const input = await request.json()
  const payload = validateCancellationInput(input)
  const origin = new URL(request.url).origin
  const basePath = getBasePath(env)
  const amount = readAmount(env)
  const metadata = flattenMetadata(payload)

  const params = {
    mode: 'payment',
    'payment_method_types[0]': 'card',
    success_url: `${origin}${basePath}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}${basePath}/cancel`,
    client_reference_id: crypto.randomUUID(),
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': readCurrency(env),
    'line_items[0][price_data][unit_amount]': String(amount),
    'line_items[0][price_data][product_data][name]': 'Gym cancellation letter mailing',
    'line_items[0][price_data][product_data][description]':
      'Print, mail, and track a membership cancellation letter.',
    'branding_settings[display_name]': env.CHECKOUT_DISPLAY_NAME || 'Gym Cancellation SaaS',
  }

  for (const [key, value] of Object.entries(metadata)) {
    params[`metadata[${key}]`] = value
  }

  const session = await stripeRequest(env, 'POST', '/v1/checkout/sessions', params)

  return {
    ok: true,
    checkout_url: session.url,
    session_id: session.id,
  }
}

async function fulfillCancellation(sessionId, env, origin) {
  assertEnv(env, 'STRIPE_SECRET_KEY')
  assertPostalFormEnv(env)

  const session = await stripeRequest(env, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`)
  if (session.status !== 'complete' || session.payment_status !== 'paid') {
    return {
      ok: false,
      status: session.status,
      payment_status: session.payment_status,
      message: 'Checkout is not paid yet.',
    }
  }

  const payload = metadataToPayload(session.metadata || {})
  const pdf = buildCancellationPdf(payload, origin)
  const postalform = await sendPostalCancellation(env, payload, pdf, session.id)

  return {
    ok: true,
    session_id: session.id,
    payment_status: session.payment_status,
    postalform,
  }
}

async function sendPostalCancellation(env, payload, pdf, sessionId) {
  const base = getPostalFormBase(env)
  const token = getPostalFormToken(env)
  const commonHeaders = {
    authorization: `Bearer ${token}`,
  }

  const uploadIntent = await postalFormRequest(base, '/v1/documents/upload-intent', {
    method: 'POST',
    headers: {
      ...commonHeaders,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      content_type: 'application/pdf',
      byte_size: pdf.byteLength,
      page_count: 1,
    }),
  })

  const uploadResponse = await fetch(uploadIntent.upload_url, {
    method: uploadIntent.upload_method || 'PUT',
    headers: {
      'content-type': 'application/pdf',
    },
    body: pdf,
  })
  if (!uploadResponse.ok) {
    throw new Error(`PostalForm upload failed with ${uploadResponse.status}`)
  }

  await postalFormRequest(base, `/v1/documents/${encodeURIComponent(uploadIntent.document_id)}/complete`, {
    method: 'POST',
    headers: {
      ...commonHeaders,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ page_count: 1 }),
  })

  const quote = await postalFormRequest(base, '/v1/letters/quotes', {
    method: 'POST',
    headers: {
      ...commonHeaders,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      document_id: uploadIntent.document_id,
      page_count: 1,
      mail_class: 'usps_first_class',
      color: false,
      double_sided: true,
      certified: true,
      certified_return_receipt: false,
      origin_country_code: payload.member.countryCode,
      destination_country_code: payload.gym.countryCode,
    }),
  })

  const order = await postalFormRequest(base, '/v1/letters', {
    method: 'POST',
    headers: {
      ...commonHeaders,
      'content-type': 'application/json',
      'idempotency-key': `gym-cancel-${sessionId}`,
    },
    body: JSON.stringify({
      quote_id: quote.quote_id,
      recipient: payload.gym,
      sender: payload.member,
      metadata: {
        app: 'gym-cancellation-saas',
        stripe_session_id: sessionId,
        gym_id: payload.gymId,
      },
    }),
  })

  return {
    quote_id: quote.quote_id,
    order_id: order.id,
    status: order.status,
    mode: order.mode,
    selected_provider: order.selected_provider,
    price_cents: order.price_cents,
    currency: order.currency,
  }
}

function validateCancellationInput(input) {
  const gymId = requiredString(input.gymId, 'gymId')
  const gym = GYMS[gymId]
  if (!gym) throw new Error('Choose a supported gym.')

  const member = {
    name: requiredString(input.name, 'name'),
    line1: requiredString(input.line1, 'line1'),
    line2: optionalString(input.line2),
    city: requiredString(input.city, 'city'),
    state: requiredString(input.state, 'state').toUpperCase(),
    postal_code: requiredString(input.postalCode, 'postalCode'),
    countryCode: 'US',
  }

  const membershipId = optionalString(input.membershipId)

  return {
    gymId,
    gym,
    member,
    membershipId,
    requestedAt: new Date().toISOString(),
  }
}

function flattenMetadata(payload) {
  const metadata = {
    gym_id: payload.gymId,
    gym_name: payload.gym.name,
    gym_line1: payload.gym.line1,
    gym_city: payload.gym.city,
    gym_state: payload.gym.state,
    gym_postal_code: payload.gym.postal_code,
    gym_country_code: payload.gym.countryCode,
    member_name: payload.member.name,
    member_line1: payload.member.line1,
    member_line2: payload.member.line2 || '',
    member_city: payload.member.city,
    member_state: payload.member.state,
    member_postal_code: payload.member.postal_code,
    member_country_code: payload.member.countryCode,
    membership_id: payload.membershipId || '',
    requested_at: payload.requestedAt,
  }

  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, String(value).slice(0, 500)]))
}

function metadataToPayload(metadata) {
  return {
    gymId: requiredString(metadata.gym_id, 'metadata.gym_id'),
    gym: {
      name: requiredString(metadata.gym_name, 'metadata.gym_name'),
      line1: requiredString(metadata.gym_line1, 'metadata.gym_line1'),
      city: requiredString(metadata.gym_city, 'metadata.gym_city'),
      state: requiredString(metadata.gym_state, 'metadata.gym_state'),
      postal_code: requiredString(metadata.gym_postal_code, 'metadata.gym_postal_code'),
      countryCode: requiredString(metadata.gym_country_code || 'US', 'metadata.gym_country_code'),
    },
    member: {
      name: requiredString(metadata.member_name, 'metadata.member_name'),
      line1: requiredString(metadata.member_line1, 'metadata.member_line1'),
      line2: optionalString(metadata.member_line2),
      city: requiredString(metadata.member_city, 'metadata.member_city'),
      state: requiredString(metadata.member_state, 'metadata.member_state'),
      postal_code: requiredString(metadata.member_postal_code, 'metadata.member_postal_code'),
      countryCode: requiredString(metadata.member_country_code || 'US', 'metadata.member_country_code'),
    },
    membershipId: optionalString(metadata.membership_id),
    requestedAt: optionalString(metadata.requested_at) || new Date().toISOString(),
  }
}

async function stripeRequest(env, method, path, params = undefined) {
  const headers = {
    authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
  }

  if (env.STRIPE_API_VERSION) {
    headers['stripe-version'] = env.STRIPE_API_VERSION
  }

  let body
  if (method !== 'GET' && params) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(params)
  }

  const response = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers,
    body,
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    const message = data?.error?.message || `Stripe request failed with ${response.status}`
    throw new Error(message)
  }

  return data
}

async function postalFormRequest(base, path, init) {
  const response = await fetch(`${base}${path}`, init)
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    const message = data?.error || data?.message || `PostalForm request failed with ${response.status}`
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message))
  }

  return data
}

function buildCancellationPdf(payload, origin) {
  const date = new Date(payload.requestedAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  const lines = [
    date,
    '',
    payload.gym.name,
    payload.gym.line1,
    `${payload.gym.city}, ${payload.gym.state} ${payload.gym.postal_code}`,
    '',
    `Re: Membership cancellation request${payload.membershipId ? ` (${payload.membershipId})` : ''}`,
    '',
    'To the membership services team:',
    '',
    `Please cancel the gym membership for ${payload.member.name} effective immediately.`,
    'I revoke authorization for any future recurring membership charges after this request is received.',
    'Please send written confirmation that the membership has been cancelled and no further dues will be billed.',
    '',
    'Member mailing address:',
    payload.member.name,
    payload.member.line1,
    ...(payload.member.line2 ? [payload.member.line2] : []),
    `${payload.member.city}, ${payload.member.state} ${payload.member.postal_code}`,
    '',
    'Sincerely,',
    '',
    payload.member.name,
    '',
    `Generated by Gym Cancellation SaaS from ${origin}.`,
  ]

  return createPdf(lines)
}

function createPdf(lines) {
  const wrapped = lines.flatMap((line) => (line ? wrapText(line, 86) : ['']))
  const escapedLines = wrapped.slice(0, 44).map((line) => `(${escapePdf(line)}) Tj`)
  const content = ['BT', '/F1 11 Tf', '14 TL', '72 730 Td', escapedLines.join('\nT*\n'), 'ET'].join('\n')

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }

  const xrefOffset = byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return new TextEncoder().encode(pdf)
}

function renderHome(url, env) {
  const cancelled = url.searchParams.get('cancelled') === '1'
  const basePath = getBasePath(env)
  return layout(`
    <main class="shell">
      <section class="workspace">
        <div class="intro">
          <p class="eyebrow">Gym Cancellation SaaS</p>
          <h1>Cancel the membership by mail.</h1>
          <p class="lede">Generate a signed cancellation letter, pay with Stripe Checkout, and send it through PostalForm.</p>
          ${cancelled ? '<p class="notice">Checkout was cancelled. No letter was mailed.</p>' : ''}
        </div>

        <form id="cancel-form" class="form">
          <label>
            Gym
            <select name="gymId" required>
              <option value="planet">Planet Fitness home club</option>
              <option value="lafitness">LA Fitness member services</option>
              <option value="anytime">Anytime Fitness home club</option>
            </select>
          </label>

          <label>
            Full name
            <input name="name" autocomplete="name" required placeholder="Jordan Lee" />
          </label>

          <label>
            Membership ID
            <input name="membershipId" autocomplete="off" placeholder="Optional" />
          </label>

          <div class="grid">
            <label>
              Address
              <input name="line1" autocomplete="address-line1" required placeholder="123 Market Street" />
            </label>
            <label>
              Apt, suite
              <input name="line2" autocomplete="address-line2" placeholder="Optional" />
            </label>
          </div>

          <div class="grid three">
            <label>
              City
              <input name="city" autocomplete="address-level2" required placeholder="Austin" />
            </label>
            <label>
              State
              <input name="state" autocomplete="address-level1" required maxlength="2" placeholder="TX" />
            </label>
            <label>
              ZIP
              <input name="postalCode" autocomplete="postal-code" required placeholder="78701" />
            </label>
          </div>

          <button type="submit" id="submit">Continue to Stripe Checkout</button>
          <p id="form-status" class="status" role="status"></p>
        </form>
      </section>

      <aside class="preview" aria-label="Letter preview">
        <div class="stamp">USPS</div>
        <div class="letter">
          <p class="date">${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
          <p>Re: Membership cancellation request</p>
          <p>Please cancel my gym membership effective immediately. I revoke authorization for future recurring charges after this request is received.</p>
          <p>Please confirm the cancellation in writing.</p>
          <p>Sincerely,<br />Member name</p>
        </div>
      </aside>
    </main>
    ${homeScript(basePath)}
  `)
}

function renderSuccess(url, env) {
  const sessionId = url.searchParams.get('session_id') || ''
  const basePath = getBasePath(env)
  return layout(`
    <main class="result-shell">
      <section class="result">
        <p class="eyebrow">Gym Cancellation SaaS</p>
        <h1>Payment verified. Preparing the letter.</h1>
        <p id="fulfillment-status" class="lede">Checking Stripe Checkout and sending the cancellation through PostalForm.</p>
        <pre id="fulfillment-detail" class="detail"></pre>
        <a href="${basePath || '/'}" class="secondary">Start another cancellation</a>
      </section>
    </main>
    <script>
      const statusEl = document.getElementById('fulfillment-status');
      const detailEl = document.getElementById('fulfillment-detail');
      async function run() {
        const sessionId = ${JSON.stringify(sessionId)};
        if (!sessionId) {
          statusEl.textContent = 'Missing Checkout Session ID.';
          return;
        }
        const response = await fetch(${JSON.stringify(`${basePath}/api/fulfill`)} + '?session_id=' + encodeURIComponent(sessionId));
        const data = await response.json();
        if (!response.ok || !data.ok) {
          statusEl.textContent = data.message || data.error || 'The letter could not be sent.';
          detailEl.textContent = JSON.stringify(data, null, 2);
          return;
        }
        statusEl.textContent = 'Letter submitted to PostalForm.';
        detailEl.textContent = JSON.stringify(data.postalform, null, 2);
      }
      run().catch((error) => {
        statusEl.textContent = error.message;
      });
    </script>
  `)
}

function renderCancel(env) {
  const basePath = getBasePath(env)
  return layout(`
    <main class="result-shell">
      <section class="result">
        <p class="eyebrow">Gym Cancellation SaaS</p>
        <h1>Checkout cancelled.</h1>
        <p class="lede">No payment was captured and no cancellation letter was mailed.</p>
        <a href="${basePath || '/'}" class="secondary">Return to form</a>
      </section>
    </main>
  `)
}

function renderNotFound() {
  return layout(`
    <main class="result-shell">
      <section class="result">
        <p class="eyebrow">Gym Cancellation SaaS</p>
        <h1>Page not found.</h1>
        <a href="/" class="secondary">Return to form</a>
      </section>
    </main>
  `)
}

function layout(body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Gym Cancellation SaaS</title>
  <meta name="description" content="A Stripe Projects demo for mailing gym cancellation letters through PostalForm." />
  <style>${styles()}</style>
</head>
<body>
  ${body}
</body>
</html>`
}

function homeScript(basePath) {
  return `<script>
    const form = document.getElementById('cancel-form');
    const button = document.getElementById('submit');
    const statusEl = document.getElementById('form-status');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      statusEl.textContent = 'Creating Checkout Session...';

      const formData = new FormData(form);
      const payload = Object.fromEntries(formData.entries());

      try {
        const response = await fetch(${JSON.stringify(`${basePath}/api/checkout`)}, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.message || data.error || 'Could not create checkout.');
        }
        window.location.href = data.checkout_url;
      } catch (error) {
        statusEl.textContent = error.message;
        button.disabled = false;
      }
    });
  </script>`
}

function styles() {
  return `
    :root {
      color-scheme: light;
      --ink: #171717;
      --muted: #60646c;
      --line: #d9dde6;
      --paper: #fffdfa;
      --surface: #f5f7fa;
      --accent: #be123c;
      --accent-dark: #881337;
      --blue: #165a72;
      --green: #0f766e;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100svh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        linear-gradient(90deg, rgba(22, 90, 114, 0.08) 0 1px, transparent 1px 100%),
        linear-gradient(180deg, rgba(22, 90, 114, 0.08) 0 1px, transparent 1px 100%),
        var(--surface);
      background-size: 44px 44px;
    }

    .shell {
      display: grid;
      grid-template-columns: minmax(0, 1.08fr) minmax(360px, 0.92fr);
      gap: clamp(28px, 4vw, 64px);
      width: min(1180px, calc(100vw - 40px));
      margin: 0 auto;
      padding: clamp(28px, 5vw, 72px) 0;
      min-height: 100svh;
      align-items: center;
    }

    .workspace {
      display: grid;
      gap: 28px;
    }

    .intro {
      display: grid;
      gap: 12px;
      max-width: 680px;
    }

    .eyebrow {
      margin: 0;
      color: var(--accent);
      font-size: 0.78rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      font-size: clamp(2.6rem, 6vw, 5.8rem);
      line-height: 0.92;
      letter-spacing: 0;
      max-width: 720px;
    }

    .lede {
      margin: 0;
      max-width: 610px;
      color: var(--muted);
      font-size: clamp(1rem, 2vw, 1.22rem);
      line-height: 1.55;
    }

    .notice {
      width: fit-content;
      margin: 0;
      padding: 10px 12px;
      border: 1px solid rgba(190, 18, 60, 0.25);
      background: rgba(255, 255, 255, 0.75);
      color: var(--accent-dark);
      font-size: 0.92rem;
    }

    .form {
      display: grid;
      gap: 16px;
      padding: 24px;
      background: rgba(255, 255, 255, 0.82);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 24px 80px rgba(21, 27, 40, 0.1);
      backdrop-filter: blur(14px);
    }

    label {
      display: grid;
      gap: 7px;
      color: #343840;
      font-size: 0.83rem;
      font-weight: 700;
    }

    input, select {
      width: 100%;
      min-height: 44px;
      padding: 10px 12px;
      border: 1px solid #cfd5df;
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      font: inherit;
      font-weight: 500;
    }

    input:focus, select:focus {
      outline: 3px solid rgba(15, 118, 110, 0.18);
      border-color: var(--green);
    }

    .grid {
      display: grid;
      grid-template-columns: 1.3fr 0.7fr;
      gap: 14px;
    }

    .grid.three {
      grid-template-columns: 1fr 90px 130px;
    }

    button, .secondary {
      min-height: 46px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 18px;
      border: 0;
      border-radius: 6px;
      background: var(--accent);
      color: white;
      font: inherit;
      font-weight: 800;
      text-decoration: none;
      cursor: pointer;
      transition: transform 160ms ease, background 160ms ease, opacity 160ms ease;
    }

    button:hover, .secondary:hover {
      background: var(--accent-dark);
      transform: translateY(-1px);
    }

    button:disabled {
      cursor: wait;
      opacity: 0.68;
      transform: none;
    }

    .status {
      min-height: 22px;
      margin: 0;
      color: var(--blue);
      font-size: 0.92rem;
      font-weight: 700;
    }

    .preview {
      position: relative;
      min-height: 680px;
      display: grid;
      place-items: center;
      perspective: 1200px;
    }

    .letter {
      width: min(440px, 88vw);
      min-height: 590px;
      padding: 58px 52px;
      background: var(--paper);
      border: 1px solid rgba(23, 23, 23, 0.12);
      box-shadow: 0 36px 100px rgba(21, 27, 40, 0.22);
      transform: rotate(-2deg);
      animation: rise 700ms ease both;
    }

    .letter p {
      margin: 0 0 22px;
      color: #333;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 1rem;
      line-height: 1.55;
    }

    .stamp {
      position: absolute;
      top: 80px;
      right: 44px;
      z-index: 2;
      width: 82px;
      height: 62px;
      display: grid;
      place-items: center;
      border: 2px solid var(--blue);
      color: var(--blue);
      font-weight: 900;
      transform: rotate(7deg);
      background: rgba(255, 255, 255, 0.72);
      animation: stamp 520ms 420ms ease both;
    }

    .result-shell {
      min-height: 100svh;
      display: grid;
      place-items: center;
      padding: 32px;
    }

    .result {
      width: min(760px, 100%);
      display: grid;
      gap: 18px;
      padding: clamp(28px, 7vw, 72px);
      background: rgba(255, 255, 255, 0.82);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 24px 80px rgba(21, 27, 40, 0.1);
    }

    .detail {
      min-height: 92px;
      margin: 0;
      padding: 16px;
      overflow: auto;
      border-radius: 6px;
      background: #111827;
      color: #d1fae5;
      font-size: 0.84rem;
      line-height: 1.5;
    }

    @keyframes rise {
      from { opacity: 0; transform: translateY(18px) rotate(-4deg); }
      to { opacity: 1; transform: translateY(0) rotate(-2deg); }
    }

    @keyframes stamp {
      from { opacity: 0; transform: translateY(-18px) scale(1.1) rotate(12deg); }
      to { opacity: 1; transform: translateY(0) scale(1) rotate(7deg); }
    }

    @media (max-width: 880px) {
      .shell {
        grid-template-columns: 1fr;
        padding-top: 28px;
      }

      .preview {
        min-height: 430px;
        order: -1;
      }

      .letter {
        min-height: 390px;
        padding: 42px 34px;
      }

      .grid, .grid.three {
        grid-template-columns: 1fr;
      }

      .stamp {
        top: 24px;
        right: 18px;
      }
    }
  `
}

function html(content, status = 200) {
  return new Response(content, {
    status,
    headers: DEFAULT_HEADERS,
  })
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function readAmount(env) {
  const amount = Number.parseInt(env.CHECKOUT_AMOUNT_CENTS || '1299', 10)
  if (!Number.isFinite(amount) || amount < 50) throw new Error('Invalid CHECKOUT_AMOUNT_CENTS')
  return amount
}

function getBasePath(env) {
  const basePath = (env.BASE_PATH || '').trim()
  if (!basePath || basePath === '/') return ''
  return basePath.startsWith('/') ? basePath.replace(/\/$/, '') : `/${basePath.replace(/\/$/, '')}`
}

function stripBasePath(pathname, env) {
  const basePath = getBasePath(env)
  if (!basePath) return pathname
  if (pathname === basePath) return '/'
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length) || '/'
  return pathname
}

function readCurrency(env) {
  return (env.CHECKOUT_CURRENCY || 'usd').toLowerCase()
}

function getPostalFormBase(env) {
  return (env.POSTALFORM_API_BASE || 'https://projects.postalform.com/api').replace(/\/$/, '')
}

function getPostalFormToken(env) {
  const postalFormEnv = parseJsonObject(env.POSTALFORM_ENV)
  const postalFormCredentials = parseJsonObject(env.POSTALFORM_CREDENTIALS)
  const testApiKey =
    env.POSTALFORM_TEST_API_KEY ||
    postalFormEnv.POSTALFORM_TEST_API_KEY ||
    postalFormCredentials.postalform?.test_api_key
  const liveApiKey =
    env.POSTALFORM_LIVE_API_KEY ||
    postalFormEnv.POSTALFORM_LIVE_API_KEY ||
    postalFormCredentials.postalform?.live_api_key

  if (env.POSTALFORM_MODE === 'live') {
    return liveApiKey || env.POSTALFORM_API_KEY || testApiKey
  }
  return testApiKey || env.POSTALFORM_API_KEY
}

function assertPostalFormEnv(env) {
  if (!getPostalFormToken(env)) {
    throw new Error('Missing POSTALFORM_TEST_API_KEY')
  }
}

function assertEnv(env, key) {
  if (!env[key]) throw new Error(`Missing ${key}`)
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing ${field}`)
  }
  return value.trim().slice(0, 160)
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : ''
}

function wrapText(text, maxChars) {
  const words = text.split(/\s+/)
  const lines = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > maxChars && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines
}

function escapePdf(value) {
  return value.replace(/[\\()]/g, (char) => `\\${char}`).replace(/[^\x20-\x7E]/g, '')
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength
}

function parseJsonObject(value) {
  if (!value || typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
