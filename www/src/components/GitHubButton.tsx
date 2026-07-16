import React, { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { GithubIcon } from './icons/GithubIcon';
import { Button } from './ui/button';

export function GitHubButton() {
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    const fetchStars = async () => {
      try {
        const response = await fetch('https://api.github.com/repos/RayLabsHQ/gitea-mirror');
        if (response.ok) {
          const data = await response.json();
          setStars(data.stargazers_count);
        }
      } catch (error) {
        console.error('Failed to fetch GitHub stars:', error);
      }
    };

    fetchStars();
  }, []);

  return (
    <>
      {/* Mobile version - compact with text */}
      <Button 
        variant="outline" 
        size="sm" 
        className="md:hidden hover:bg-primary/10 hover:border-primary/30 hover:text-foreground transition-all duration-300 px-3" 
        asChild
      >
        <a href="https://github.com/RayLabsHQ/gitea-mirror" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5">
          <Star className="w-4 h-4" />
          <span className="font-semibold">{stars || '—'}</span>
        </a>
      </Button>
      
      {/* Desktop version - full button */}
      <Button 
        variant="outline" 
        size="sm" 
        className="hidden md:flex hover:bg-primary/10 hover:border-primary/30 hover:text-foreground transition-all duration-300" 
        asChild
      >
        <a href="https://github.com/RayLabsHQ/gitea-mirror" target="_blank" rel="noopener noreferrer" className="flex items-center">
          <GithubIcon className="w-4 h-4 mr-2" />
          <span>Star on GitHub</span>
          {stars !== null && (
            <>
              <span className="mx-2 text-muted-foreground">•</span>
              <Star className="w-3 h-3 mr-1" />
              <span>{stars}</span>
            </>
          )}
        </a>
      </Button>
    </>
  );
}