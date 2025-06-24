'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { toast, Toaster } from 'sonner';
import { showErrorToast } from '@/lib/utils';

export function SignupForm() {
  const [isLoading, setIsLoading] = useState(false);

  async function handleSignup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsLoading(true);
    const form = e.currentTarget;
    const formData = new FormData(form);
    const username = formData.get('username') as string | null;
    const email = formData.get('email') as string | null;
    const password = formData.get('password') as string | null;
    const confirmPassword = formData.get('confirmPassword') as string | null;

    if (!username || !email || !password || !confirmPassword) {
      toast.error('Please fill in all fields');
      setIsLoading(false);
      return;
    }

    if (password !== confirmPassword) {
      toast.error('Passwords do not match');
      setIsLoading(false);
      return;
    }

    const signupData = { username, email, password };

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(signupData),
      });

      const data = await response.json();

      if (response.ok) {
        toast.success('Account created successfully! Redirecting to dashboard...');
        // The cookie should be set by the response, so we can redirect immediately
        // Use replace to avoid redirect loop issues
        setTimeout(() => {
          window.location.replace('/');
        }, 1500);
      } else {
        showErrorToast(data.error || 'Failed to create account. Please try again.', toast);
      }
    } catch (error) {
      showErrorToast(error, toast);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <img
              src="/logo-light.svg"
              alt="Gitea Mirror Logo"
              className="h-10 w-10 dark:hidden"
            />
            <img
              src="/logo-dark.svg"
              alt="Gitea Mirror Logo"
              className="h-10 w-10 hidden dark:block"
            />
          </div>
          <CardTitle className="text-2xl">Create Admin Account</CardTitle>
          <CardDescription>
            Set up your administrator account for Gitea Mirror
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form id="signup-form" onSubmit={handleSignup}>
            <div className="space-y-4">
              <div>
                <label htmlFor="username" className="block text-sm font-medium mb-1">
                  Username
                </label>
                <input
                  id="username"
                  name="username"
                  type="text"
                  required
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="Enter your username"
                  disabled={isLoading}
                />
              </div>
              <div>
                <label htmlFor="email" className="block text-sm font-medium mb-1">
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="Enter your email"
                  disabled={isLoading}
                />
              </div>
              <div>
                <label htmlFor="password" className="block text-sm font-medium mb-1">
                  Password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="Create a password"
                  disabled={isLoading}
                />
              </div>
              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium mb-1">
                  Confirm Password
                </label>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  required
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="Confirm your password"
                  disabled={isLoading}
                />
              </div>
            </div>
          </form>
        </CardContent>
        <CardFooter>
          <Button type="submit" form="signup-form" className="w-full" disabled={isLoading}>
            {isLoading ? 'Creating Account...' : 'Create Admin Account'}
          </Button>
        </CardFooter>
      </Card>
      <Toaster />
    </>
  );
}
