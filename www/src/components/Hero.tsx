import { Button } from "./ui/button";
import { Shield, RefreshCw, HardDrive, GitBranch } from "lucide-react";
import React, { Suspense } from 'react';

const Spline = React.lazy(() => import('@splinetool/react-spline'));

export function Hero() {

  return (
    <section className="relative min-h-[100vh] pt-20 pb-10 flex flex-col items-center justify-center px-4 sm:px-6 lg:px-8 overflow-hidden">
      {/* spline object */}
      <div className="spline-object absolute inset-0 max-lg:-z-10 max-h-[40rem] -translate-y-16 md:max-h-[50rem] lg:max-h-[60%] xl:max-h-[70%] 2xl:max-h-[80%] md:-translate-y-24 lg:-translate-y-28 flex items-center justify-center">

        <div className="block md:hidden w-[80%]">
          <img
            src="/assets/hero_logo.webp"
            alt="Gitea Mirror hero image"
            className="w-full h-full object-contain"
          />
          </div>
        <div className="absolute right-2 bottom-4 h-20 w-40 bg-background hidden md:block"/>
        <Suspense fallback={
          <div className="w-full h-full md:flex items-center justify-center hidden">
            <img
              src="/assets/hero_logo.webp"
              alt="Gitea Mirror hero logo"
              className="w-[200px] h-[160px] md:w-[280px] md:h-[240px] lg:w-[360px] lg:h-[320px] xl:w-[420px] xl:h-[380px] 2xl:w-[480px] 2xl:h-[420px] object-contain"
            />
          </div>
        }>
          <Spline
            scene="https://prod.spline.design/jl0aKWbdH9vHQnYV/scene.splinecode"
            className="hidden md:block"
          />  
        </Suspense>
      </div>
      {/* div to avoid clipping in lower screen heights */}
      <div className="clip-avoid w-full h-[16rem] md:h-[20rem] lg:h-[12rem] 2xl:h-[16rem]" aria-hidden="true"></div>
      <div className="max-w-7xl mx-auto pb-20 lg:pb-60 xl:pb-24 text-center w-full">
        <h1 className="pt-10 2xl:pt-20 text-3xl xs:text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-tight">
          <span className="text-foreground">Backup Your GitHub</span>
          <br />
          <span className="text-gradient from-primary via-accent to-accent-purple">
            To Self-Hosted Gitea
          </span>
        </h1>

        <p className="mt-4 sm:mt-6 text-base sm:text-lg md:text-xl text-muted-foreground max-w-3xl mx-auto px-4 z-20">
          Automatic, private, and free. Own your code history forever.
          Preserve issues, PRs, releases, and wiki in your own Gitea server.
        </p>
        <p className="mt-3 text-sm sm:text-base text-muted-foreground max-w-2xl mx-auto px-4 z-20">
          It also mirrors from GitLab, Gitea and Forgejo, including Codeberg, and can push to GitHub, GitLab and Forgejo.
          Those paths are in beta. GitHub to Gitea is the supported default.
        </p>

        <div className="mt-6 sm:mt-8 flex flex-wrap items-center justify-center gap-3 text-xs sm:text-sm text-muted-foreground px-4 z-20">
          <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary">
            <HardDrive className="w-3 h-3 sm:w-4 sm:h-4" />
            <span className="font-medium">Self-Hosted Backup</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-accent/10 text-accent">
            <RefreshCw className="w-3 h-3 sm:w-4 sm:h-4" />
            <span className="font-medium">Automated Syncing</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-accent-purple/10 text-accent-purple">
            <Shield className="w-3 h-3 sm:w-4 sm:h-4" />
            <span className="font-medium">$0/month</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-accent-teal/10 text-accent-teal">
            <GitBranch className="w-3 h-3 sm:w-4 sm:h-4" />
            <span className="font-medium">GitLab, Forgejo and Codeberg in beta</span>
          </div>
        </div>

         {/* Product Hunt Badge */}
        <div className="mt-6 sm:mt-8 flex items-center justify-center px-4 z-20">
          <a 
            href="https://www.producthunt.com/products/gitea-mirror?embed=true&utm_source=badge-featured&utm_medium=badge&utm_source=badge-gitea-mirror" 
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block transition-transform hover:scale-105"
          >
            <img 
              src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1013721&theme=light&t=1757620787136" 
              alt="Gitea Mirror - Automated github to gitea repository mirroring & backup | Product Hunt" 
              style={{ width: '250px', height: '54px' }}
              width="250" 
              height="54" 
              className="dark:hidden"
            />
            <img 
              src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1013721&theme=dark&t=1757620890723" 
              alt="Gitea Mirror - Automated github to gitea repository mirroring & backup | Product Hunt" 
              style={{ width: '250px', height: '54px' }}
              width="250" 
              height="54" 
              className="hidden dark:block"
            />
          </a>
        </div>
      </div>
    </section>
  );
}
