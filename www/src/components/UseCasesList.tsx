
import { useCases } from '@/lib/use-cases';
import { ArrowRight } from 'lucide-react';

const featured = useCases.slice(0, 3);
const more = useCases.slice(3);

export function FeaturedUseCases() {
  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-3">
      {featured.map((item) => (
        <article key={item.slug} className="group relative flex flex-col rounded-3xl border border-primary/50 bg-primary/5 p-6 sm:p-7 shadow-lg shadow-primary/10 transition-all duration-300 hover:-translate-y-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {item.tags.map((tag) => (
              <span key={tag} className="inline-flex items-center rounded-full border border-muted px-2.5 py-1">{tag}</span>
            ))}
          </div>
          <h2 className="mt-4 text-xl font-semibold sm:text-2xl text-foreground">{item.title}</h2>
          <p className="mt-3 text-sm sm:text-base text-muted-foreground">{item.summary}</p>
          <div className="mt-5 grid gap-3 text-sm text-muted-foreground">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/70">Pain point</h3>
              <p>{item.painPoint}</p>
            </div>
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/70">Outcome</h3>
              <p>{item.outcome}</p>
            </div>
          </div>
          <a
            href={`/use-cases/${item.slug}/`}
            className="mt-6 inline-flex w-max items-center gap-2 rounded-full border border-primary/50 px-4 py-2 text-sm font-semibold text-primary transition-colors hover:bg-primary/10"
          >
            View playbook
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </a>
        </article>
      ))}
    </div>
  );
}

export function MoreUseCases() {
    return (
        <div className="mt-8 grid gap-6 md:grid-cols-2">
        {more.map((item) => (
          <article key={item.slug} className="group relative flex flex-col rounded-3xl border border-muted bg-background/70 p-6 sm:p-7 transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {item.tags.map((tag) => (
                <span key={tag} className="inline-flex items-center rounded-full border border-muted px-2.5 py-1">{tag}</span>
              ))}
            </div>
  
            <h2 className="mt-4 text-xl font-semibold sm:text-2xl text-foreground/90">{item.title}</h2>
            <p className="mt-3 text-sm sm:text-base text-muted-foreground">{item.summary}</p>
  
            <div className="mt-5 grid gap-3 text-sm text-muted-foreground">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/70">Pain point</h3>
                <p>{item.painPoint}</p>
              </div>
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/70">Outcome</h3>
                <p>{item.outcome}</p>
              </div>
            </div>
  
            <a
              href={`/use-cases/${item.slug}/`}
              className="mt-6 inline-flex w-max items-center gap-2 rounded-full border border-primary/50 px-4 py-2 text-sm font-semibold text-primary transition-colors hover:bg-primary/10"
            >
              View playbook
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </a>
          </article>
        ))}
      </div>
    )
}
