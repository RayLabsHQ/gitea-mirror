/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    user?: import("@/lib/db/schema").User;
    authMethod?: "local" | "forward" | "oidc";
  }
}