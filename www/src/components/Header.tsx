import React, { useEffect, useState } from 'react';
import { ThemeToggle } from './ThemeToggle';
import { GitHubButton } from './GitHubButton';

export function Header() {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10);
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const navLinks = [
    { href: '/#features', label: 'Features' },
    { href: '/#use-cases', label: 'Use Cases' },
    { href: '/#screenshots', label: 'Screenshots' },
    { href: '/#installation', label: 'Installation' }
  ];

  return (
    <header className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
      isScrolled ? 'backdrop-blur-lg bg-background/80 border-b shadow-sm' : 'bg-background/50'
    }`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <a href="/" className="flex items-center gap-2 group">
            <img
              src="/assets/logo.png"
              alt="Gitea Mirror Logo"
              className="w-7 h-6 md:w-10 md:h-8"
            />
            <span className="text-lg sm:text-xl font-bold">Gitea Mirror</span>
          </a>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <a 
                key={link.href}
                href={link.href} 
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>

          {/* Desktop Actions */}
          <div className="hidden md:flex items-center gap-4">
            <ThemeToggle />
            <GitHubButton />
          </div>

          {/* Mobile Actions */}
          <div className="flex md:hidden items-center gap-3">
            <GitHubButton />
            <ThemeToggle />
          </div>
        </div>
      </div>

    </header>
  );
}
