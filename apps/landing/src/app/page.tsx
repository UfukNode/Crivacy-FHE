"use client";

import { useCallback, useState } from "react";

import ClickSpark from "@/components/react-bits/ClickSpark";
import { ApplicationDock } from "@/components/sections/ApplicationDock";
import { EarlyAccessModal } from "@/components/sections/EarlyAccessModal";
import { Features } from "@/components/sections/Features";
import { FinalCta } from "@/components/sections/FinalCta";
import { Footer } from "@/components/sections/Footer";
import { Hero } from "@/components/sections/Hero";
import { HowItWorks } from "@/components/sections/HowItWorks";
import { Navbar } from "@/components/sections/Navbar";
import { PrivacyShield } from "@/components/sections/PrivacyShield";
import { Roadmap } from "@/components/sections/Roadmap";
import { StatsEcosystem } from "@/components/sections/StatsEcosystem";
import { Team } from "@/components/sections/Team";
import { ValidatorCode } from "@/components/sections/ValidatorCode";
import { VideoSection } from "@/components/sections/VideoSection";
import { WatchSection } from "@/components/sections/WatchSection";
import { useThemeColors } from "@/lib/use-theme-colors";

export default function Home() {
  const [modalOpen, setModalOpen] = useState(false);
  const colors = useThemeColors();

  const openModal = useCallback(() => setModalOpen(true), []);

  return (
    <ClickSpark
      sparkColor={colors.accentPrimary}
      sparkSize={8}
      sparkRadius={22}
      sparkCount={10}
      duration={500}
      className="relative flex w-full flex-1 flex-col"
    >
      <Navbar />

      <main className="flex flex-1 flex-col">
        <Hero onRequestAccess={openModal} />
        <PrivacyShield />
        <HowItWorks />
        <WatchSection />
        <Features />
        <VideoSection />
        <StatsEcosystem />
        <ValidatorCode />
        <Roadmap />
        <Team />
        <FinalCta />
        <Footer />
      </main>

      <ApplicationDock />

      <EarlyAccessModal open={modalOpen} onOpenChange={setModalOpen} />
    </ClickSpark>
  );
}
