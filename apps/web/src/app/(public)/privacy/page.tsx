import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy',
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold text-[var(--color-fg)]">Privacy Policy</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">Last updated: April 2026</p>

      <div className="mt-8 space-y-8 text-sm leading-relaxed text-[var(--color-fg)]">
        {/* 1. Data Controller */}
        <section>
          <h2 className="text-lg font-semibold">1. Data Controller</h2>
          <p className="mt-2">
            Crivacy (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) is the data controller
            responsible for the processing of your personal data. We are committed to protecting
            your privacy in compliance with the General Data Protection Regulation (GDPR), the
            Turkish Personal Data Protection Law (KVKK, Law No. 6698), and other applicable data
            protection legislation.
          </p>
          <p className="mt-2">
            For questions about this policy or to exercise your rights, contact our Data Protection
            Officer at{' '}
            <a href="mailto:privacy@crivacy.io" className="text-[var(--color-accent)] hover:underline">
              privacy@crivacy.io
            </a>.
          </p>
        </section>

        {/* 2. Data We Collect */}
        <section>
          <h2 className="text-lg font-semibold">2. Data We Collect</h2>
          <p className="mt-2">We collect the following categories of personal data:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <strong>Account data:</strong> email address, display name, phone number, and
              password hash.
            </li>
            <li>
              <strong>Identity verification data:</strong> full legal name, date of birth,
              nationality, document type, document country, and identity document images (processed
              by Didit).
            </li>
            <li>
              <strong>Address verification data:</strong> street address, city, and country (from
              Didit phase 2 verification).
            </li>
            <li>
              <strong>Technical data:</strong> IP address, user agent, device information, session
              data, and browser cookies.
            </li>
            <li>
              <strong>Usage data:</strong> pages visited, features used, timestamps of interactions,
              and KYC verification status.
            </li>
            <li>
              <strong>Blockchain data:</strong> KYC credential records stored on Sepolia
              distributed ledger.
            </li>
          </ul>
        </section>

        {/* 3. How We Use Your Data */}
        <section>
          <h2 className="text-lg font-semibold">3. How We Use Your Data</h2>
          <p className="mt-2">We process your personal data for the following purposes:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>To create and manage your account.</li>
            <li>To perform identity and address verification through our KYC process.</li>
            <li>To issue and manage on-chain KYC credentials.</li>
            <li>To communicate with you regarding your account and verification status.</li>
            <li>To provide customer support via our ticketing system.</li>
            <li>To detect, prevent, and address fraud, abuse, and security incidents.</li>
            <li>To comply with legal obligations, including AML/CTF regulations.</li>
            <li>To improve and optimize the Service.</li>
          </ul>
        </section>

        {/* 4. Legal Basis */}
        <section>
          <h2 className="text-lg font-semibold">4. Legal Basis for Processing</h2>
          <p className="mt-2">
            We process your personal data under the following legal bases as defined by GDPR Article
            6 and KVKK Article 5:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <strong>Contract performance:</strong> Processing necessary to provide the Service you
              requested (account management, KYC verification, credential issuance).
            </li>
            <li>
              <strong>Legal obligation:</strong> Processing required to comply with AML/CTF
              regulations, tax laws, and other legal requirements.
            </li>
            <li>
              <strong>Legitimate interest:</strong> Processing for fraud prevention, security, and
              service improvement, where our interests do not override your fundamental rights.
            </li>
            <li>
              <strong>Consent:</strong> Where explicitly required, such as for certain marketing
              communications. You may withdraw consent at any time.
            </li>
          </ul>
        </section>

        {/* 5. Data Retention */}
        <section>
          <h2 className="text-lg font-semibold">5. Data Retention</h2>
          <p className="mt-2">We retain your personal data according to the following schedule:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <strong>Account data:</strong> Retained for the duration of your account plus 30 days
              after deletion request, unless extended retention is required by law.
            </li>
            <li>
              <strong>KYC verification data:</strong> Retained for a minimum of 5 years after the
              last verification, as required by AML/CTF regulations.
            </li>
            <li>
              <strong>Audit logs:</strong> Retained for 7 years to comply with regulatory
              requirements.
            </li>
            <li>
              <strong>Technical logs:</strong> Retained for 90 days for security and debugging
              purposes.
            </li>
            <li>
              <strong>Blockchain records:</strong> On-chain records are immutable and cannot be
              deleted. Credentials may be revoked but the record of issuance persists.
            </li>
          </ul>
        </section>

        {/* 6. Your Rights */}
        <section>
          <h2 className="text-lg font-semibold">6. Your Rights (GDPR/KVKK)</h2>
          <p className="mt-2">
            Under GDPR and KVKK, you have the following rights regarding your personal data:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <strong>Right of access:</strong> Request a copy of all personal data we hold about
              you.
            </li>
            <li>
              <strong>Right to rectification:</strong> Request correction of inaccurate or
              incomplete data.
            </li>
            <li>
              <strong>Right to erasure:</strong> Request deletion of your personal data, subject to
              legal retention requirements.
            </li>
            <li>
              <strong>Right to restriction:</strong> Request that we limit the processing of your
              data in certain circumstances.
            </li>
            <li>
              <strong>Right to data portability:</strong> Receive your data in a structured,
              commonly used, machine-readable format.
            </li>
            <li>
              <strong>Right to object:</strong> Object to processing based on legitimate interests
              or for direct marketing purposes.
            </li>
            <li>
              <strong>Right to withdraw consent:</strong> Where processing is based on consent, you
              may withdraw it at any time.
            </li>
            <li>
              <strong>Right to lodge a complaint:</strong> You may file a complaint with the
              relevant supervisory authority (KVKK Board in Turkey, or your local EU/EEA data
              protection authority).
            </li>
          </ul>
          <p className="mt-2">
            To exercise any of these rights, contact us at{' '}
            <a href="mailto:privacy@crivacy.io" className="text-[var(--color-accent)] hover:underline">
              privacy@crivacy.io
            </a>
            . We will respond within 30 days as required by GDPR, or within 30 days as required by
            KVKK.
          </p>
        </section>

        {/* 7. International Transfers */}
        <section>
          <h2 className="text-lg font-semibold">7. International Data Transfers</h2>
          <p className="mt-2">
            Your personal data may be transferred to and processed in countries outside your country
            of residence, including Turkey and countries within the European Economic Area (EEA). We
            ensure that such transfers are carried out with appropriate safeguards:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Standard Contractual Clauses (SCCs) approved by the European Commission.</li>
            <li>Adequacy decisions by the relevant data protection authority.</li>
            <li>
              Explicit consent where required and no other safeguard mechanism is available.
            </li>
          </ul>
        </section>

        {/* 8. Cookies */}
        <section>
          <h2 className="text-lg font-semibold">8. Cookies</h2>
          <p className="mt-2">
            We use only essential cookies that are strictly necessary for the operation of the
            Service:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <strong>Session cookies:</strong> Used to maintain your authenticated session and keep
              you signed in. These are HTTP-only, secure cookies that expire when your session ends
              or after the configured timeout period.
            </li>
            <li>
              <strong>CSRF protection cookies:</strong> Used to prevent cross-site request forgery
              attacks.
            </li>
          </ul>
          <p className="mt-2">
            We do not use analytics, advertising, or tracking cookies. No third-party cookies are
            set by the Service.
          </p>
        </section>

        {/* 9. Third-Party Services */}
        <section>
          <h2 className="text-lg font-semibold">9. Third-Party Services</h2>
          <p className="mt-2">
            We share personal data with the following third-party processors:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <strong>Didit:</strong> Our identity verification provider. Didit processes your
              identity documents and biometric data to perform KYC verification. Didit acts as a
              data processor under a Data Processing Agreement (DPA) with Crivacy. For more
              information, see{' '}
              <a
                href="https://www.didit.me/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-accent)] hover:underline"
              >
                Didit&apos;s Privacy Policy
              </a>.
            </li>
            <li>
              <strong>Ethereum (Sepolia):</strong> KYC credential records are stored on Sepolia
              distributed ledger. The Sepolia network stores credential data (sensitive fields encrypted via FHE) (verification level,
              issuance date, credential ID) but does not process raw identity documents or biometric
              data.
            </li>
          </ul>
        </section>

        {/* 10. Data Security */}
        <section>
          <h2 className="text-lg font-semibold">10. Data Security</h2>
          <p className="mt-2">
            We implement appropriate technical and organizational measures to protect your personal
            data, including:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Encryption of data in transit (TLS 1.3) and at rest (AES-256).</li>
            <li>
              Passwords stored using Argon2id hashing with per-user salts and appropriate memory/time
              parameters.
            </li>
            <li>Role-based access control (RBAC) for internal administrative access.</li>
            <li>Comprehensive audit logging of all data access and modifications.</li>
            <li>Regular security assessments and vulnerability scanning.</li>
            <li>Brute-force protection with account lockout and IP-based rate limiting.</li>
          </ul>
        </section>

        {/* 11. Updates to Policy */}
        <section>
          <h2 className="text-lg font-semibold">11. Updates to This Policy</h2>
          <p className="mt-2">
            We may update this Privacy Policy from time to time to reflect changes in our practices
            or applicable laws. We will notify you of material changes by posting a notice on our
            website or sending an email to your registered email address. Your continued use of the
            Service after the effective date of the updated policy constitutes acceptance of the
            changes.
          </p>
        </section>

        {/* 12. Contact */}
        <section>
          <h2 className="text-lg font-semibold">12. Contact</h2>
          <p className="mt-2">
            If you have questions about this Privacy Policy, wish to exercise your data protection
            rights, or need to report a data protection concern, please contact us:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Data Protection Officer:{' '}
              <a href="mailto:privacy@crivacy.io" className="text-[var(--color-accent)] hover:underline">
                privacy@crivacy.io
              </a>
            </li>
            <li>
              General inquiries:{' '}
              <a href="mailto:info@crivacy.io" className="text-[var(--color-accent)] hover:underline">
                info@crivacy.io
              </a>
            </li>
            <li>
              Website:{' '}
              <a href="https://crivacy.io" className="text-[var(--color-accent)] hover:underline">
                https://crivacy.io
              </a>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
