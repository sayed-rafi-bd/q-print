import type { ReactNode } from 'react';
import { useCapabilities } from './capabilities';
import { LIMITS } from './generator/engine';
import { MOCK_LIST_PATH, MOCK_PRODUCTS_URL } from './generator/mockApi';

/**
 * The Guide tab: a plain-language walk through the app, written for the person printing labels
 * rather than the person who built it. Static on purpose; it reads nothing and calls nothing.
 */

const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section
    id={id}
    aria-labelledby={`${id}-title`}
    className="space-y-3 rounded-2xl border border-slate-200 bg-white/80 p-5 shadow-sm"
  >
    <h2 id={`${id}-title`} className="text-lead font-semibold text-slate-800">
      {title}
    </h2>
    <div className="space-y-3 text-sm leading-relaxed text-slate-700">{children}</div>
  </section>
);

const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.85em] text-slate-800">{children}</code>
);

const Steps = ({ children }: { children: ReactNode }) => (
  <ol className="list-decimal space-y-1.5 pl-5 marker:font-semibold marker:text-indigo-600">{children}</ol>
);

const Note = ({ children }: { children: ReactNode }) => (
  <p className="rounded-xl bg-indigo-50 p-3 text-xs text-indigo-900 ring-1 ring-indigo-200">{children}</p>
);

const SAMPLE_RESPONSE = `{
  "data": [
    { "title": "Alpha", "code": "A-1", "price": { "amount": 980 } },
    { "title": "Beta",  "code": "B-2", "price": { "amount": 1200 } }
  ]
}`;

export default function GuidePage() {
  const { platform } = useCapabilities();
  const web = platform === 'web';

  const contents: [string, string][] = [
    ['guide-start', 'The basics'],
    ...(web ? [] : ([['guide-print', 'Printing a label']] as [string, string][])),
    ['guide-api', 'Reading data from an API'],
    ...(web ? [] : ([['guide-api-server', 'Printing from another program']] as [string, string][])),
    ['guide-designer', 'Designing a label'],
    ['guide-trouble', 'If something goes wrong'],
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 pb-10 md:p-8">
      <header className="space-y-1">
        <h1 className="text-xl font-bold text-slate-900">Guide</h1>
        <p className="text-sm text-slate-600">
          How to print labels and how to connect them to your data. Nothing on this page changes anything.
        </p>
      </header>

      <nav aria-label="On this page" className="flex flex-wrap gap-2">
        {contents.map(([id, title]) => (
          <a
            key={id}
            href={`#${id}`}
            onClick={(e) => {
              // A plain #hash would change the page's address; scroll to the section instead.
              e.preventDefault();
              document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-indigo-50 hover:text-indigo-700"
          >
            {title}
          </a>
        ))}
      </nav>

      <Section id="guide-start" title="The basics">
        <p>
          A <strong>label</strong> is a layout (text, barcodes, QR codes) plus a set of rules that say what goes in each
          field. Every time you print, the app fills the fields in, makes one page per label and sends the pages to your
          printer.
        </p>
        <p>A field gets its value in one of two ways:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Made by the app</strong> — a fixed text, a random number, a pick from a list, a date, and so on.
            These need nothing from you when you print.
          </li>
          <li>
            <strong>Read from an API</strong> — the value comes from your own system, such as an order or a product
            record. For these you give the address of the API each time you print.
          </li>
        </ul>
        {web && (
          <Note>
            This is the web version: you can design labels here, but printing needs the desktop or Android app.
          </Note>
        )}
      </Section>

      {!web && (
        <Section id="guide-print" title="Printing a label">
          <Steps>
            <li>
              Open the <strong>Print</strong> tab and choose the <strong>Label</strong>.
            </li>
            <li>
              Choose the <strong>Printer</strong>. If yours is not listed, use “Add a printer”.
            </li>
            <li>
              Look at the <strong>Data source</strong> box.
              <ul className="mt-1 list-disc space-y-1 pl-5">
                <li>
                  If it is <strong>greyed out</strong>, this label makes its own values. There is nothing to enter.
                </li>
                <li>
                  If it is <strong>active</strong>, this label reads from an API. Fill it in as described in the next
                  section, then press <strong>Check data</strong>.
                </li>
              </ul>
            </li>
            <li>
              Set the number of pages. For a label that reads from an API this is the number of copies of{' '}
              <em>each record</em>: 5 records × 3 copies = 15 pages.
            </li>
            <li>
              Press <strong>Print</strong>. The result is shown when the job has been sent.
            </li>
          </Steps>
          <p>
            One print job can be at most {LIMITS.maxRows.toLocaleString()} pages. The app tells you before it sends
            anything if a job is over that.
          </p>
        </Section>
      )}

      <Section id="guide-api" title="Reading data from an API">
        <p>
          The address of the API belongs to <em>you</em>, not to the label. It is typed in when you print and is not
          saved with the label or included when a label is exported. So a label file you receive from someone else can
          never send a request anywhere you did not choose.
        </p>

        <h3 className="font-semibold text-slate-800">What you fill in</h3>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Address</strong> — for example <Code>api.example.com/orders/{'{orderId}'}</Code>. You can leave out{' '}
            <Code>https://</Code>. Anything in curly braces is a <strong>variable</strong>: a box with that name appears
            and you type the value there (the order number, a date, a count). The line “Will call” shows the exact
            address that will be used.
          </li>
          <li>
            <strong>Where the list is in the response</strong> — if the API answers with the list directly, leave this
            empty. If the list is inside something else, say where, separated by dots: <Code>data</Code> or{' '}
            <Code>data.items</Code>.
          </li>
          <li>
            <strong>Send an access token</strong> — tick this if the API needs a login token. It is sent with this one
            request and is never saved.
          </li>
        </ul>

        <h3 className="font-semibold text-slate-800">What the API should return</h3>
        <p>
          JSON. Either a list of records (one label page per record) or a single record. For example, with the list path
          set to <Code>data</Code>:
        </p>
        <pre className="overflow-auto rounded-xl bg-slate-900 p-3 text-xs text-slate-100">{SAMPLE_RESPONSE}</pre>
        <p>
          Each label field then reads one value from the record by its path, such as <Code>title</Code> or{' '}
          <Code>price.amount</Code>. The answer must be smaller than {LIMITS.maxResponseBytes / 1024 / 1024} MB and must
          not be an empty list.
        </p>

        <h3 className="font-semibold text-slate-800">Check data before printing</h3>
        <p>
          <strong>Check data</strong> makes the request and tells you how many records it found and how many pages that
          will be. Open “First record” to see what the API sent. Changing anything in the box clears the check.
        </p>

        <h3 className="font-semibold text-slate-800">Try it without a server</h3>
        <p>
          The app has a built-in demo API that works offline. Use this address, with the list path{' '}
          <Code>{MOCK_LIST_PATH}</Code>:
        </p>
        <p className="break-all">
          <Code>{MOCK_PRODUCTS_URL}</Code>
        </p>
        <p>
          Type how many records you want in <Code>count</Code>. No request leaves your device.
        </p>
        {web && (
          <Note>
            In a browser the API has to allow requests from this site (CORS). The desktop and Android apps do not have
            this restriction.
          </Note>
        )}
      </Section>

      <Section id="guide-api-server" title="Printing from another program">
        <p>
          While the app is running, anything on this PC can print through it: a till, an accounts system, a script, or{' '}
          <Code>curl</Code>. Open the <strong>API</strong> tab to turn the API on, see the address and the token, and
          try every endpoint without writing any code.
        </p>
        <Steps>
          <li>
            Open the <strong>API</strong> tab and press <strong>Send</strong> on <Code>GET /health</Code>.
          </li>
          <li>
            Copy the token, then paste the <strong>curl</strong> snippet into a terminal and add the token where the{' '}
            <Code>&lt;your-token&gt;</Code> placeholder is.
          </li>
          <li>
            To print a label the app already has, use <Code>POST /print</Code> with its label name and a printer. To
            print a PDF you already have, use <Code>POST /print/pdf</Code>.
          </li>
          <li>
            On <Code>POST /print</Code>, set <Code>"dryRun"</Code> to <Code>true</Code> to get the PDF back instead of
            printing it. That is the safe way to check a layout before spending paper.
          </li>
        </Steps>
        <p>
          Closing the window does not stop any of this. The window goes to the tray and the API keeps working;{' '}
          <strong>Exit</strong> in the tray menu is what shuts it down.
        </p>
        <Note>
          The API listens on this PC only, and needs the token on every call but <Code>/health</Code>. It is off when
          you turn it off on the API tab, and changing the port or the token there takes effect at once.
        </Note>
      </Section>

      <Section id="guide-designer" title="Designing a label">
        <Steps>
          <li>
            Open the <strong>Designer</strong> tab and pick a label, or create a new one.
          </li>
          <li>Place and style the fields on the page: text, barcodes, QR codes, tables.</li>
          <li>
            In the <strong>Data</strong> tab, choose how each field gets its value. Choose the API option and enter the
            path of the value inside a record (<Code>title</Code>, <Code>price.amount</Code>) for fields that come from
            your system.
          </li>
          <li>
            Use <strong>Test with a real API</strong> to fetch a few records and preview the label with real values. The
            address you type there is for testing only and is not saved with the label.
          </li>
          <li>
            <strong>Save</strong>. A label that has at least one API field will then ask for an address on the Print
            tab.
          </li>
        </Steps>
        <Note>
          The designer needs a large screen. On an Android phone it is hidden; use a tablet, or design on a computer.
        </Note>
      </Section>

      <Section id="guide-trouble" title="If something goes wrong">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>“Enter a value for …”</strong> — the address has a variable in braces; fill in the box with that
            name.
          </li>
          <li>
            <strong>HTTP 401 or 403</strong> — the API wants a login. Tick “Send an access token” and enter it.
          </li>
          <li>
            <strong>HTTP 404</strong> — the address or one of its values is wrong. Check what you typed in “Will call”.
          </li>
          <li>
            <strong>“The list path … ”</strong> — the place you gave is not in the response. Open “First record” after
            Check data, or look at the response, and correct the path.
          </li>
          <li>
            <strong>Data source is greyed out but you expected an API</strong> — the label has no field set to read from
            an API. Open it in the Designer and set the fields that should.
          </li>
          <li>
            <strong>Nothing printed</strong> — check the printer name, and that the paper size matches the label.
          </li>
        </ul>
      </Section>
    </div>
  );
}
