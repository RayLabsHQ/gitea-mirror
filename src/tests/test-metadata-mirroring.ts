#!/usr/bin/env bun

/**
 * Test script to verify metadata mirroring authentication works correctly
 * This tests the fix for issue #68 - "user does not exist [uid: 0, name: ]"
 * Run with: bun run src/tests/test-metadata-mirroring.ts
 */

import { mirrorGitRepoIssuesToGitea } from "@/lib/gitea";
import { validateGiteaAuth } from "@/lib/gitea-auth-validator";
import { getConfigsByUserId } from "@/lib/db/queries/configs";
import { db, users, repositories } from "@/lib/db";
import { eq } from "drizzle-orm";
import { createGitHubClient } from "@/lib/github";
import type { Repository } from "@/lib/db/schema";

async function testMetadataMirroringAuth() {
  console.log("=".repeat(60));
  console.log("METADATA MIRRORING AUTHENTICATION TEST");
  console.log("=".repeat(60));
  
  try {
    // Get the first user for testing
    const userList = await db.select().from(users).limit(1);
    
    if (userList.length === 0) {
      console.error("❌ No users found in database. Please set up a user first.");
      process.exit(1);
    }
    
    const user = userList[0];
    console.log(`\n✅ Found user: ${user.email} (ID: ${user.id})`);
    
    // Get the user's configuration
    const configs = await getConfigsByUserId(user.id);
    
    if (configs.length === 0) {
      console.error("❌ No configuration found for user. Please configure GitHub and Gitea settings.");
      process.exit(1);
    }
    
    const config = configs[0];
    console.log(`✅ Found configuration (ID: ${config.id})`);
    
    if (!config.giteaConfig?.url || !config.giteaConfig?.token) {
      console.error("❌ Gitea configuration is incomplete. URL or token is missing.");
      process.exit(1);
    }
    
    if (!config.githubConfig?.token) {
      console.error("❌ GitHub configuration is incomplete. Token is missing.");
      process.exit(1);
    }
    
    console.log(`\n📡 Testing Gitea connection to: ${config.giteaConfig.url}`);
    console.log("-".repeat(60));
    
    // Test 1: Validate Gitea authentication
    console.log("\n🔐 Test 1: Validating Gitea authentication...");
    let giteaUser;
    try {
      giteaUser = await validateGiteaAuth(config);
      console.log(`✅ Gitea authentication successful!`);
      console.log(`   - Username: ${giteaUser.username || giteaUser.login}`);
      console.log(`   - User ID: ${giteaUser.id}`);
      console.log(`   - Is Admin: ${giteaUser.is_admin}`);
    } catch (error) {
      console.error(`❌ Gitea authentication failed: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`   This is the root cause of the "user does not exist [uid: 0]" error`);
      process.exit(1);
    }
    
    // Test 2: Check if we can access a test repository
    console.log("\n📦 Test 2: Looking for a test repository...");
    
    // Get a repository from the database
    const repos = await db.select().from(repositories)
      .where(eq(repositories.userId, user.id))
      .limit(1);
    
    if (repos.length === 0) {
      console.log("⚠️  No repositories found in database. Skipping metadata mirroring test.");
      console.log("   Please run a mirror operation first to test metadata mirroring.");
    } else {
      const testRepo = repos[0] as Repository;
      console.log(`✅ Found test repository: ${testRepo.fullName}`);
      
      // Test 3: Verify repository exists in Gitea
      console.log("\n🔍 Test 3: Verifying repository exists in Gitea...");
      
      const { isRepoPresentInGitea } = await import("@/lib/gitea");
      const giteaOwner = giteaUser.username || giteaUser.login;
      
      const repoExists = await isRepoPresentInGitea({
        config,
        owner: giteaOwner,
        repoName: testRepo.name,
      });
      
      if (!repoExists) {
        console.log(`⚠️  Repository ${testRepo.name} not found in Gitea at ${giteaOwner}`);
        console.log(`   This would cause metadata mirroring to fail with authentication errors`);
        console.log(`   Please ensure the repository is mirrored first before attempting metadata sync`);
      } else {
        console.log(`✅ Repository exists in Gitea at ${giteaOwner}/${testRepo.name}`);
        
        // Test 4: Attempt to mirror metadata (dry run)
        console.log("\n🔄 Test 4: Testing metadata mirroring authentication...");
        
        try {
          // Create Octokit instance (honors GH_API_URL for GHES / GHEC data residency)
          const octokit = createGitHubClient(config.githubConfig.token);
          
          // Test by attempting to fetch labels (lightweight operation)
          const { httpGet } = await import("@/lib/http-client");
          const { decryptConfigTokens } = await import("@/lib/utils/config-encryption");
          const decryptedConfig = decryptConfigTokens(config);
          
          const labelsResponse = await httpGet(
            `${config.giteaConfig.url}/api/v1/repos/${giteaOwner}/${testRepo.name}/labels`,
            {
              Authorization: `token ${decryptedConfig.giteaConfig.token}`,
            }
          );
          
          console.log(`✅ Successfully authenticated for metadata operations`);
          console.log(`   - Can access repository labels endpoint`);
          console.log(`   - Found ${labelsResponse.data.length} existing labels`);
          console.log(`   - Authentication token is valid and has proper permissions`);
          
        } catch (error) {
          if (error instanceof Error && error.message.includes('uid: 0')) {
            console.error(`❌ CRITICAL: Authentication failed with "uid: 0" error!`);
            console.error(`   This is the exact issue from GitHub issue #68`);
            console.error(`   Error: ${error.message}`);
          } else {
            console.error(`❌ Metadata operation failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
    
    console.log("\n" + "=".repeat(60));
    console.log("TEST COMPLETE");
    console.log("=".repeat(60));
    
    // Summary
    console.log("\n📊 Summary:");
    console.log(`   - Gitea URL: ${config.giteaConfig.url}`);
    console.log(`   - Gitea User: ${giteaUser?.username || giteaUser?.login || 'Unknown'}`);
    console.log(`   - Authentication: ${giteaUser ? '✅ Valid' : '❌ Invalid'}`);
    console.log(`   - Metadata Mirroring: ${config.giteaConfig.mirrorMetadata ? 'Enabled' : 'Disabled'}`);
    if (config.giteaConfig.mirrorMetadata) {
      console.log(`   - Issues: ${config.giteaConfig.mirrorIssues ? 'Yes' : 'No'}`);
      console.log(`   - Pull Requests: ${config.giteaConfig.mirrorPullRequests ? 'Yes' : 'No'}`);
      console.log(`   - Labels: ${config.giteaConfig.mirrorLabels ? 'Yes' : 'No'}`);
      console.log(`   - Milestones: ${config.giteaConfig.mirrorMilestones ? 'Yes' : 'No'}`);
    }
    
    console.log("\n✨ If all tests passed, metadata mirroring should work without uid:0 errors!");
    
  } catch (error) {
    console.error("\n❌ Test failed with error:", error);
    process.exit(1);
  }
  
  process.exit(0);
}

// Run the test
testMetadataMirroringAuth().catch(console.error);