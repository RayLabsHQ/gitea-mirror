import React from 'react';
import { Button } from './ui/button';
import { ArrowRight } from 'lucide-react';
import { GitHubStats } from './GitHubStats';

export function CTA() {
  return (
    <section className="py-16 sm:py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl bg-card/80 border border-primary/10 p-6 sm:p-8 md:p-12 text-center shadow-xl">
          {/* Subtle gradient accent */}
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 pointer-events-none" />
          <div className="absolute -top-24 -right-24 w-48 h-48 bg-primary/20 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-accent/20 rounded-full blur-3xl pointer-events-none" />
          
          <div className="relative">
            <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold mb-4">
              <span className="block sm:inline">Start Protecting</span>
              <span className="text-gradient from-primary via-accent to-accent-purple block sm:inline"> Your Code Today</span>
            </h2>
            <p className="text-base sm:text-lg text-muted-foreground mb-6 sm:mb-8 max-w-2xl mx-auto px-4">
              Join developers who trust Gitea Mirror to keep their repositories safe and accessible. 
              Free, open source, and ready to deploy.
            </p>

            {/* Stats */}
            <GitHubStats />

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4">
              <Button size="lg" className="group w-full sm:w-auto min-h-[48px] bg-gradient-to-r from-primary to-accent hover:from-primary/90 hover:to-accent/90 shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 transition-all duration-300" asChild>
                <a href="https://github.com/RayLabsHQ/gitea-mirror" target="_blank" rel="noopener noreferrer">
                  Get Started Now
                  <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
                </a>
              </Button>
              <Button size="lg" variant="outline" className="w-full sm:w-auto min-h-[48px] bg-background/80 hover:bg-primary/10 hover:border-primary/30 hover:text-foreground transition-all duration-300" asChild>
                <a href="https://github.com/RayLabsHQ/gitea-mirror/discussions" target="_blank" rel="noopener noreferrer">
                  Join Community
                </a>
              </Button>
            </div>
          </div>
        </div>

        {/* Open source note */}
        <div className="mt-8 sm:mt-12 text-center">
          <p className="text-xs sm:text-sm text-muted-foreground">
            Gitea Mirror is licensed under GPL-3.0. 
            <a href="https://github.com/RayLabsHQ/gitea-mirror/blob/main/LICENSE" 
               className="ml-1 underline hover:text-foreground transition-colors"
               target="_blank" 
               rel="noopener noreferrer">
              View License
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}