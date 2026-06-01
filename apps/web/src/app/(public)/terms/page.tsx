import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service',
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold text-[var(--color-fg)]">Terms of Service</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">Last updated: April 2026</p>

      <div className="mt-8 space-y-8 text-sm leading-relaxed text-[var(--color-fg)]">
        {/* 1. Terms of Use */}
        <section>
          <h2 className="text-lg font-semibold">1. Terms of Use</h2>
          <p className="mt-2">
            These Terms of Service (&quot;Terms&quot;) govern your access to and use of the Crivacy
            platform, including our website, APIs, and related services (collectively, the
            &quot;Service&quot;). By accessing or using the Service, you agree to be bound by these
            Terms. If you do not agree to these Terms, you may not access or use the Service.
          </p>
          <p className="mt-2">
            Crivacy reserves the right to modify these Terms at any time. Changes will be effective
            upon posting to this page. Your continued use of the Service after changes are posted
            constitutes acceptance of the modified Terms.
          </p>
        </section>

        {/* 2. Eligibility */}
        <section>
          <h2 className="text-lg font-semibold">2. Eligibility</h2>
          <p className="mt-2">
            You must be at least 18 years old and have the legal capacity to enter into a binding
            agreement to use the Service. By creating an account, you represent and warrant that you
            meet these eligibility requirements.
          </p>
          <p className="mt-2">
            The Service is available to individuals and businesses globally, subject to applicable
            sanctions and export control laws. Users in jurisdictions where KYC verification services
            are prohibited by law may not use the Service.
          </p>
        </section>

        {/* 3. Account Registration */}
        <section>
          <h2 className="text-lg font-semibold">3. Account Registration</h2>
          <p className="mt-2">
            To access the Service, you must create an account by providing accurate and complete
            information, including a valid email address and a secure password. You are responsible
            for maintaining the confidentiality of your account credentials.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>You must verify your email address before accessing core features.</li>
            <li>You may not create multiple accounts for the same individual or entity.</li>
            <li>You must promptly notify Crivacy of any unauthorized access to your account.</li>
            <li>
              Crivacy reserves the right to suspend or terminate accounts that violate these Terms.
            </li>
          </ul>
        </section>

        {/* 4. KYC Verification */}
        <section>
          <h2 className="text-lg font-semibold">4. KYC Verification</h2>
          <p className="mt-2">
            The Service provides Know Your Customer (KYC) verification through our identity
            verification partner, Didit. By initiating verification, you consent to the collection
            and processing of your identity documents and biometric data as described in our Privacy
            Policy.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Verification results are recorded on-chain (Sepolia) as immutable credentials.
            </li>
            <li>You must provide genuine, unaltered identity documents during verification.</li>
            <li>
              Providing false, fraudulent, or misleading information is strictly prohibited and may
              result in permanent account termination.
            </li>
            <li>
              Verification decisions are based on automated processes and may be subject to manual
              review.
            </li>
          </ul>
        </section>

        {/* 5. Data Processing */}
        <section>
          <h2 className="text-lg font-semibold">5. Data Processing</h2>
          <p className="mt-2">
            We process your personal data in accordance with our Privacy Policy and applicable data
            protection laws, including the General Data Protection Regulation (GDPR) and the Turkish
            Personal Data Protection Law (KVKK, Law No. 6698).
          </p>
          <p className="mt-2">
            By using the Service, you acknowledge that your data may be processed in jurisdictions
            outside your country of residence, subject to appropriate safeguards as described in our
            Privacy Policy.
          </p>
        </section>

        {/* 6. User Rights */}
        <section>
          <h2 className="text-lg font-semibold">6. User Rights</h2>
          <p className="mt-2">As a user of the Service, you have the right to:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Access your personal data held by Crivacy.</li>
            <li>Request correction of inaccurate personal data.</li>
            <li>Request deletion of your account and associated data, subject to legal retention requirements.</li>
            <li>Object to certain processing of your personal data.</li>
            <li>Receive your data in a portable format.</li>
            <li>Lodge a complaint with a supervisory authority.</li>
          </ul>
          <p className="mt-2">
            To exercise these rights, contact us at{' '}
            <a href="mailto:privacy@crivacy.io" className="text-[var(--color-accent)] hover:underline">
              privacy@crivacy.io
            </a>.
          </p>
        </section>

        {/* 7. Intellectual Property */}
        <section>
          <h2 className="text-lg font-semibold">7. Intellectual Property</h2>
          <p className="mt-2">
            All content, features, and functionality of the Service, including but not limited to
            text, graphics, logos, icons, software, and underlying technology, are the exclusive
            property of Crivacy or its licensors and are protected by international copyright,
            trademark, patent, and other intellectual property laws.
          </p>
          <p className="mt-2">
            You may not copy, modify, distribute, sell, or lease any part of the Service without
            prior written consent from Crivacy.
          </p>
        </section>

        {/* 8. Limitation of Liability */}
        <section>
          <h2 className="text-lg font-semibold">8. Limitation of Liability</h2>
          <p className="mt-2">
            To the maximum extent permitted by applicable law, Crivacy shall not be liable for any
            indirect, incidental, special, consequential, or punitive damages, or any loss of
            profits or revenues, whether incurred directly or indirectly, or any loss of data, use,
            goodwill, or other intangible losses resulting from:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Your use of or inability to use the Service.</li>
            <li>Any unauthorized access to or alteration of your data.</li>
            <li>Delays or failures in the verification process.</li>
            <li>Any third-party conduct on the Service.</li>
          </ul>
        </section>

        {/* 9. Governing Law */}
        <section>
          <h2 className="text-lg font-semibold">9. Governing Law</h2>
          <p className="mt-2">
            These Terms shall be governed by and construed in accordance with the laws of the
            Republic of Turkey, without regard to its conflict of law provisions. Any disputes
            arising out of or relating to these Terms shall be subject to the exclusive jurisdiction
            of the courts of Istanbul, Turkey.
          </p>
        </section>

        {/* 10. Contact */}
        <section>
          <h2 className="text-lg font-semibold">10. Contact</h2>
          <p className="mt-2">
            If you have any questions about these Terms, please contact us:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Email:{' '}
              <a href="mailto:legal@crivacy.io" className="text-[var(--color-accent)] hover:underline">
                legal@crivacy.io
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
