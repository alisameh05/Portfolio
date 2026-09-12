workspace "ShipWithAli" "Recruiter-first portfolio and owner-operated publishing workspace for AI/ML product work." {
    !identifiers hierarchical

    model {
        visitor = person "Visitor" "Explores public work, reads Case studies, accesses the Current CV, interacts with Projects, and uses Contact channels without an account." "Person,External,Public" {
            properties {
                "Owner" "External"
                "Data Classification" "Public and purpose-limited pseudonymous interaction data"
                "Requirements" "FR-01,FR-02,FR-03,FR-07,FR-08,FR-09,FR-12"
                "ADRs" "0002,0003,0004,0008,0009"
            }
        }

        owner = person "Owner" "The single authenticated operator who publishes content, manages configuration, moderates Feedback, activates CV versions, reviews analytics, and produces Owner exports." "Person,External,Confidential" {
            properties {
                "Owner" "External"
                "Data Classification" "Confidential"
                "Requirements" "FR-04,FR-05,FR-06,FR-08,FR-09,FR-10,FR-11,FR-12"
                "ADRs" "0001,0004,0005,0010,0011,0013"
            }
        }

        shipWithAli = softwareSystem "ShipWithAli" "Serves the bilingual public portfolio and the Owner workspace while preserving evidence-led publication, privacy, resilience, and portability." "Target System,Internal,Confidential" {
            properties {
                "Owner" "ShipWithAli"
                "Data Classification" "Public, confidential, and restricted records"
                "Requirements" "FR-01..FR-14,NFR-01..NFR-09"
                "ADRs" "0001..0015"
                "Architecture" "Domain-oriented modular monolith"
                "structurizr.inspection.model.softwaresystem.documentation" "ignore"
                "structurizr.inspection.model.softwaresystem.decisions" "ignore"
                "Inspection Note" "The remote MCP string parser cannot resolve repository-relative !docs or !adrs; documentation and decisions are versioned beside this workspace."
            }

            web = container "Next.js Application" "Server-renders public routes, hosts the Owner workspace and narrow mutation routes, executes domain modules, and dispatches scheduled work as one deployment." "Next.js App Router, React, TypeScript, Vercel Functions" "Application,Internal,Confidential" {
                properties {
                    "Owner" "ShipWithAli"
                    "Data Classification" "Public requests, confidential Owner sessions, restricted submissions"
                    "Requirements" "FR-01..FR-14,NFR-01..NFR-09"
                    "ADRs" "0002,0008,0009,0012,0013,0014"
                }

                publicExperience = component "Public Experience" "Resolves locale and durable routes, renders the landing page, discovery, Timeline, Case studies, Current CV access, interactions, and graceful fallbacks." "Next.js Server Components and narrow Route Handlers" "Module,Public" {
                    properties {
                        "Owner" "ShipWithAli"
                        "Data Classification" "Public"
                        "Requirements" "FR-01,FR-02,FR-03,FR-07,FR-08,FR-12,FR-13,FR-14"
                        "ADRs" "0002,0003,0007,0008,0009,0010"
                    }
                }

                ownerWorkspace = component "Owner Workspace" "Maps authenticated forms to conceptual Owner commands and displays drafts, Moderation, analytics, exports, and operational state." "Next.js Server Actions and private Route Handlers" "Module,Confidential" {
                    properties {
                        "Owner" "ShipWithAli"
                        "Data Classification" "Confidential"
                        "Requirements" "FR-04,FR-05,FR-06,FR-08,FR-09,FR-10,FR-11,FR-12"
                        "ADRs" "0001,0004,0005,0010,0011,0013"
                    }
                }

                portfolioConfiguration = component "Portfolio Configuration" "Owns the public profile, Contact channels, Global project CTA, safe destination availability, and their histories." "TypeScript domain module" "Module,Confidential" {
                    properties {
                        "Owner" "Portfolio Configuration module"
                        "Data Classification" "Public configuration and confidential history"
                        "Requirements" "FR-12"
                        "ADRs" "0008,0012"
                    }
                }

                contentPublishing = component "Content and Publishing" "Owns Projects, Achievements, Testimonials, immutable Revisions, evidence, lifecycle, language publications, Project relationships, External links, routes, and redirects." "TypeScript domain module" "Module,Restricted" {
                    properties {
                        "Owner" "Content and Publishing module"
                        "Data Classification" "Public content, confidential drafts, restricted evidence"
                        "Requirements" "FR-01,FR-02,FR-03,FR-04,FR-13,FR-14"
                        "ADRs" "0001,0003,0006,0007,0008,0009,0010,0012,0014"
                    }
                }

                taxonomyDiscovery = component "Taxonomy and Discovery" "Owns controlled Taxonomies, value evolution, searchable public Project projections, filters, and newest-published ordering." "TypeScript domain module and PostgreSQL full-text/trigram search" "Module,Public" {
                    properties {
                        "Owner" "Taxonomy and Discovery module"
                        "Data Classification" "Public labels and confidential evolution history"
                        "Requirements" "FR-02,FR-06"
                        "ADRs" "0003,0005,0012"
                    }
                }

                mediaLibrary = component "Media" "Owns private upload candidates, safety and suitability checks, accessibility metadata, accepted Media assets, provider-independent object references, and variants." "TypeScript domain module" "Module,Restricted" {
                    properties {
                        "Owner" "Media module"
                        "Data Classification" "Restricted uploads and public accepted variants"
                        "Requirements" "FR-05"
                        "ADRs" "0002,0008,0010,0013"
                    }
                }

                cvPortfolio = component "CV Portfolio" "Owns accepted CV versions and atomically maintains the single English Current CV designation." "TypeScript domain module" "Module,Restricted" {
                    properties {
                        "Owner" "CV Portfolio module"
                        "Data Classification" "Restricted candidate files and public Current CV"
                        "Requirements" "FR-08"
                        "ADRs" "0009,0010,0012,0014"
                    }
                }

                interactionModeration = component "Interaction and Moderation" "Owns Reactions, Ratings, private Feedback, immutable Moderation decisions, current choices, and public aggregates." "TypeScript domain module" "Module,Restricted" {
                    properties {
                        "Owner" "Interaction and Moderation module"
                        "Data Classification" "Restricted Feedback and pseudonymous interaction data"
                        "Requirements" "FR-07"
                        "ADRs" "0004,0006,0012,0014,0015"
                    }
                }

                measurement = component "Measurement" "Owns consented Public event data, Analytics goal versions, Journey context, daily aggregates, retention, and Low-sample reporting." "TypeScript domain module" "Module,Restricted" {
                    properties {
                        "Owner" "Measurement module"
                        "Data Classification" "Restricted pseudonymous events and aggregate reports"
                        "Requirements" "FR-09,NFR-06"
                        "ADRs" "0004,0008,0012,0014,0015"
                    }
                }

                identityAccess = component "Identity and Access" "Authorizes the allowlisted Owner, scheduled jobs, short-lived abuse signals, consent state, and separate functional and analytics identities." "TypeScript domain module" "Module,Restricted" {
                    properties {
                        "Owner" "Identity and Access module"
                        "Data Classification" "Restricted authentication and purpose-limited identity data"
                        "Requirements" "FR-07,FR-09,FR-11,NFR-05,NFR-06"
                        "ADRs" "0004,0012,0013,0015"
                    }
                }

                portabilityOperations = component "Portability and Operations" "Owns Owner export schemas and integrity, outbox records, job leases, retries, backup evidence, recovery state, and actionable Operational alerts." "TypeScript domain module and PostgreSQL-backed job runner" "Module,Restricted" {
                    properties {
                        "Owner" "Portability and Operations module"
                        "Data Classification" "Restricted exports, operational metadata, and recovery evidence"
                        "Requirements" "FR-10,NFR-03,NFR-07,NFR-08"
                        "ADRs" "0008,0011,0012,0014"
                    }
                }

                providerAdapters = component "Provider Adapters" "Implements seams for PostgreSQL transactions and repositories, Supabase Storage and Auth, GitHub OAuth, Vercel cache and scheduling, Resend, Sentry, clocks, and backup artifacts." "TypeScript adapters and provider SDKs" "Adapter,Restricted" {
                    properties {
                        "Owner" "ShipWithAli infrastructure"
                        "Data Classification" "Restricted credentials and translated provider data"
                        "Requirements" "NFR-03,NFR-05,NFR-07,NFR-08,NFR-09"
                        "ADRs" "0011,0012,0013,0014"
                    }
                }
            }

            database = container "Portfolio Database" "Stores module-owned relational records, public read projections, immutable histories, idempotency records, outbox entries, and job leases under Row Level Security." "Supabase PostgreSQL with connection pooling" "Database,Internal,Restricted" {
                properties {
                    "Owner" "ShipWithAli modules"
                    "Data Classification" "Public, confidential, and restricted records"
                    "Requirements" "FR-02..FR-13,NFR-01,NFR-03,NFR-05,NFR-06,NFR-07"
                    "ADRs" "0001,0004,0005,0010,0011,0013,0014,0015"
                }
            }

            objectStorage = container "Object Storage" "Keeps private upload candidates, accepted public media variants, Current CV objects, encrypted exports, and recovery artifacts behind stable Media asset identities." "Supabase Storage through an object-storage adapter" "Storage,Internal,Restricted" {
                properties {
                    "Owner" "Media, CV Portfolio, and Portability and Operations modules"
                    "Data Classification" "Restricted originals and public accepted variants"
                    "Requirements" "FR-05,FR-08,FR-10,NFR-07,NFR-09"
                    "ADRs" "0008,0010,0011,0013"
                }
            }
        }

        supabaseAuth = softwareSystem "Supabase Auth" "Creates application sessions and delegates the Owner identity challenge to GitHub OAuth." "External,Restricted" {
            properties {
                "Owner" "Supabase"
                "Technology" "Supabase Auth and OAuth 2.0/OIDC"
                "Data Classification" "Restricted authentication metadata"
                "Requirements" "FR-11,NFR-05"
                "ADRs" "0013"
            }
        }

        githubOAuth = softwareSystem "GitHub OAuth" "Authenticates the Owner's GitHub identity; access is granted only when the immutable provider subject is allowlisted." "External,Restricted" {
            properties {
                "Owner" "GitHub"
                "Technology" "OAuth 2.0 over HTTPS"
                "Data Classification" "Restricted identity metadata"
                "Requirements" "FR-11,NFR-05"
                "ADRs" "0013"
            }
        }

        vercelPlatform = softwareSystem "Vercel Platform" "Provides CDN delivery, serverless execution, cache tags, preview promotion, rollback, and scheduled invocation." "External,Operational" {
            properties {
                "Owner" "Vercel"
                "Technology" "Vercel CDN, Functions, Cache, and Cron"
                "Data Classification" "Public responses and operational metadata"
                "Requirements" "NFR-01,NFR-02,NFR-03,NFR-08"
                "ADRs" "0008,0013,0014"
            }
        }

        resend = softwareSystem "Resend" "Delivers best-effort actionable Owner notifications without participating in publication transactions." "External,Confidential" {
            properties {
                "Owner" "Resend"
                "Technology" "Transactional email over HTTPS"
                "Data Classification" "Confidential Owner destination and minimal alert content"
                "Requirements" "NFR-03,NFR-08"
                "ADRs" "0008,0013,0014"
            }
        }

        sentry = softwareSystem "Sentry" "Receives scrubbed exceptions and sampled traces for actionable operational diagnosis." "External,Operational" {
            properties {
                "Owner" "Sentry"
                "Technology" "Sentry ingestion over HTTPS"
                "Data Classification" "Scrubbed operational metadata"
                "Requirements" "NFR-05,NFR-08"
                "ADRs" "0004,0008,0013"
            }
        }

        githubActions = softwareSystem "GitHub Actions" "Runs tests, architecture checks, expand-contract migration gates, deployment promotion, encrypted backups, and restore rehearsals." "External,Restricted" {
            properties {
                "Owner" "GitHub"
                "Technology" "GitHub Actions workflows and encrypted artifacts"
                "Data Classification" "Restricted deployment and encrypted recovery metadata"
                "Requirements" "NFR-04,NFR-05,NFR-07,NFR-08,NFR-09"
                "ADRs" "0008,0011,0013"
            }
        }

        externalDestinations = softwareSystem "External Destinations" "Hosts GitHub repositories, live demos, professional profiles, social channels, and other truthfully labeled Project or Contact destinations." "External,Public" {
            properties {
                "Owner" "Independent third parties"
                "Technology" "HTTPS and explicitly allowed contact schemes"
                "Data Classification" "Public destination and outbound navigation metadata"
                "Requirements" "FR-01,FR-02,FR-03,FR-12,NFR-03"
                "ADRs" "0008,0009"
            }
        }

        futureMeasurement = softwareSystem "Future Measurement Service" "Conditional extraction target when event volume exceeds one million per day or aggregation delays operational transactions." "Future,Internal,Restricted" {
            properties {
                "Owner" "Future accountable team"
                "Technology" "Independent service, database, and versioned event consumer"
                "Data Classification" "Restricted pseudonymous measurement data"
                "Requirements" "NFR-01,NFR-09"
                "ADRs" "0012,0014"
            }
        }

        futureMedia = softwareSystem "Future Media Service" "Conditional extraction target when processing exceeds serverless limits or backlog remains above five minutes." "Future,Internal,Restricted" {
            properties {
                "Owner" "Future accountable team"
                "Technology" "Independent service, database, object adapter, and versioned event consumer"
                "Data Classification" "Restricted media originals and processing metadata"
                "Requirements" "NFR-01,NFR-09"
                "ADRs" "0012,0013,0014"
            }
        }

        futureInteractions = softwareSystem "Future Interaction Service" "Conditional extraction target when public interactions exceed 250 sustained writes per second." "Future,Internal,Restricted" {
            properties {
                "Owner" "Future accountable team"
                "Technology" "Independent service, database, and versioned event consumer"
                "Data Classification" "Restricted Feedback and pseudonymous interaction data"
                "Requirements" "NFR-01,NFR-09"
                "ADRs" "0012,0014"
            }
        }

        futureSearch = softwareSystem "Future Search Service" "Conditional read-model extraction when public documents exceed 100,000 and tuned PostgreSQL search remains above 300 ms p95." "Future,Internal,Public" {
            properties {
                "Owner" "Future accountable team"
                "Technology" "Independent search projection consuming versioned events"
                "Data Classification" "Public published-content projection"
                "Requirements" "FR-02,NFR-01,NFR-02,NFR-09"
                "ADRs" "0012,0014"
            }
        }

        visitor -> shipWithAli "Uses the bilingual public portfolio and submits permitted interactions" "HTTPS"
        owner -> shipWithAli "Operates the private publishing workspace" "HTTPS"
        shipWithAli -> supabaseAuth "Delegates Owner session establishment" "Supabase Auth over HTTPS"
        supabaseAuth -> githubOAuth "Delegates the Owner identity challenge" "OAuth 2.0 over HTTPS"
        shipWithAli -> vercelPlatform "Runs public delivery, server execution, cache, and schedules" "Vercel managed platform"
        shipWithAli -> resend "Sends best-effort actionable Owner notifications" "Resend HTTPS API"
        shipWithAli -> sentry "Sends scrubbed exceptions and sampled traces" "Sentry HTTPS ingestion"
        githubActions -> shipWithAli "Validates, deploys, backs up, and rehearses recovery" "GitHub Actions over HTTPS and PostgreSQL/TLS"
        visitor -> externalDestinations "Follows truthfully labeled Project and Contact destinations" "HTTPS or explicitly allowed contact scheme"
        shipWithAli -> externalDestinations "Publishes safe outbound destination metadata" "HTTPS"
        shipWithAli -> futureMeasurement "May extract Measurement after its quantitative or ownership trigger" "Versioned outbox events and HTTPS" {
            tags "Future"
        }
        shipWithAli -> futureMedia "May extract Media after its quantitative or ownership trigger" "Versioned outbox events and HTTPS" {
            tags "Future"
        }
        shipWithAli -> futureInteractions "May extract Interaction and Moderation after its quantitative or ownership trigger" "Versioned outbox events and HTTPS" {
            tags "Future"
        }
        shipWithAli -> futureSearch "May extract the public search projection after its quantitative or ownership trigger" "Versioned outbox events and HTTPS" {
            tags "Future"
        }

        visitor -> shipWithAli.web.publicExperience "Requests public pages and permitted mutations" "HTTPS"
        owner -> shipWithAli.web.ownerWorkspace "Submits authenticated Owner commands" "HTTPS"
        vercelPlatform -> shipWithAli.web.publicExperience "Delivers cached requests to the application" "Vercel CDN and HTTPS"
        vercelPlatform -> shipWithAli.web.portabilityOperations "Invokes scheduled job batches" "Authenticated HTTPS"

        shipWithAli.web -> shipWithAli.database "Reads and writes module-owned records through pooled connections" "PostgreSQL over TLS"
        shipWithAli.web -> shipWithAli.objectStorage "Reads and writes private and accepted objects through signed operations" "Supabase Storage HTTPS API"
        shipWithAli.web -> supabaseAuth "Establishes and refreshes Owner sessions" "Supabase Auth over HTTPS"
        shipWithAli.web -> vercelPlatform "Invalidates tagged caches and reports runtime health" "Vercel runtime interface"
        shipWithAli.web -> resend "Sends best-effort notifications" "Resend HTTPS API"
        shipWithAli.web -> sentry "Reports scrubbed failures and traces" "Sentry HTTPS ingestion"

        shipWithAli.web.publicExperience -> shipWithAli.web.portfolioConfiguration "Reads public profile, Contact channels, and Global project CTA" "In-process TypeScript interface"
        shipWithAli.web.publicExperience -> shipWithAli.web.contentPublishing "Resolves durable routes and published Language versions" "In-process TypeScript interface"
        shipWithAli.web.publicExperience -> shipWithAli.web.taxonomyDiscovery "Searches and filters Published Projects" "In-process TypeScript interface"
        shipWithAli.web.publicExperience -> shipWithAli.web.cvPortfolio "Resolves the locale-appropriate Current CV result" "In-process TypeScript interface"
        shipWithAli.web.publicExperience -> shipWithAli.web.interactionModeration "Submits interactions and reads public aggregates" "In-process TypeScript interface"
        shipWithAli.web.publicExperience -> shipWithAli.web.measurement "Records consented allowlisted events" "In-process TypeScript interface"
        shipWithAli.web.publicExperience -> externalDestinations "Renders truthfully labeled outbound destinations" "HTTPS links"

        shipWithAli.web.ownerWorkspace -> shipWithAli.web.identityAccess "Requires the allowlisted Owner for every command" "In-process TypeScript interface"
        shipWithAli.web.ownerWorkspace -> shipWithAli.web.portfolioConfiguration "Manages public configuration" "In-process TypeScript interface"
        shipWithAli.web.ownerWorkspace -> shipWithAli.web.contentPublishing "Executes publishing commands" "In-process TypeScript interface"
        shipWithAli.web.ownerWorkspace -> shipWithAli.web.taxonomyDiscovery "Executes Taxonomy commands" "In-process TypeScript interface"
        shipWithAli.web.ownerWorkspace -> shipWithAli.web.mediaLibrary "Prepares and accepts Media assets" "In-process TypeScript interface"
        shipWithAli.web.ownerWorkspace -> shipWithAli.web.cvPortfolio "Accepts and activates CV versions" "In-process TypeScript interface"
        shipWithAli.web.ownerWorkspace -> shipWithAli.web.interactionModeration "Reviews and moderates Feedback" "In-process TypeScript interface"
        shipWithAli.web.ownerWorkspace -> shipWithAli.web.measurement "Manages Analytics goals and reads reports" "In-process TypeScript interface"
        shipWithAli.web.ownerWorkspace -> shipWithAli.web.portabilityOperations "Requests exports and reads operational state" "In-process TypeScript interface"

        shipWithAli.web.contentPublishing -> shipWithAli.web.mediaLibrary "Validates accepted public Media references" "In-process TypeScript interface"
        shipWithAli.web.contentPublishing -> shipWithAli.web.taxonomyDiscovery "Validates controlled classifications and updates the public search projection" "In-process TypeScript interface"
        shipWithAli.web.contentPublishing -> shipWithAli.web.portfolioConfiguration "Reads the Global project CTA and destination availability" "In-process TypeScript interface"
        shipWithAli.web.cvPortfolio -> shipWithAli.web.mediaLibrary "Validates that a candidate CV file is accepted" "In-process TypeScript interface"
        shipWithAli.web.interactionModeration -> shipWithAli.web.identityAccess "Obtains purpose-limited functional identity and abuse policy" "In-process TypeScript interface"
        shipWithAli.web.measurement -> shipWithAli.web.identityAccess "Validates consent and purpose-limited analytics identity" "In-process TypeScript interface"

        shipWithAli.web.portfolioConfiguration -> shipWithAli.web.providerAdapters "Persists configuration through its owned repository" "Transaction and repository port"
        shipWithAli.web.contentPublishing -> shipWithAli.web.providerAdapters "Commits domain state, route projections, and outbox records atomically" "Transaction and repository port"
        shipWithAli.web.taxonomyDiscovery -> shipWithAli.web.providerAdapters "Persists Taxonomy history and queries indexed public projections" "Repository and search port"
        shipWithAli.web.mediaLibrary -> shipWithAli.web.providerAdapters "Stores candidates and variants and persists acceptance state" "Object storage and repository ports"
        shipWithAli.web.cvPortfolio -> shipWithAli.web.providerAdapters "Persists versions and Current CV replacement atomically" "Transaction and repository port"
        shipWithAli.web.interactionModeration -> shipWithAli.web.providerAdapters "Persists idempotent interactions, Feedback, decisions, aggregates, and outbox entries" "Transaction, repository, and rate-limit ports"
        shipWithAli.web.measurement -> shipWithAli.web.providerAdapters "Persists allowlisted events, goals, aggregates, retention work, and outbox entries" "Transaction and repository port"
        shipWithAli.web.identityAccess -> shipWithAli.web.providerAdapters "Verifies OAuth sessions, schedules, signed identities, and short-lived abuse signals" "Authentication, clock, and cryptography ports"
        shipWithAli.web.portabilityOperations -> shipWithAli.web.providerAdapters "Leases jobs, creates exports and backups, invalidates caches, sends alerts, and records recovery evidence" "Repository, storage, cache, email, monitoring, and clock ports"

        shipWithAli.web.providerAdapters -> shipWithAli.database "Executes module-owned queries, transactions, RLS policies, outbox claims, and job leases" "PostgreSQL over TLS"
        shipWithAli.web.providerAdapters -> shipWithAli.objectStorage "Uses private uploads, accepted public objects, signed downloads, exports, and backup artifacts" "Supabase Storage HTTPS API"
        shipWithAli.web.providerAdapters -> supabaseAuth "Verifies and refreshes application sessions" "Supabase Auth over HTTPS"
        shipWithAli.web.providerAdapters -> vercelPlatform "Invalidates cache tags and uses runtime and schedule metadata" "Vercel runtime interface"
        shipWithAli.web.providerAdapters -> resend "Sends minimal actionable Owner notifications" "Resend HTTPS API"
        shipWithAli.web.providerAdapters -> sentry "Sends scrubbed exceptions and sampled traces" "Sentry HTTPS ingestion"
        githubActions -> shipWithAli.database "Applies gated migrations and creates encrypted logical backups" "PostgreSQL over TLS"
        githubActions -> shipWithAli.objectStorage "Creates encrypted weekly storage and Owner-export artifacts" "Supabase Storage HTTPS API"
        githubActions -> vercelPlatform "Promotes verified previews and selects prior deployments for rollback" "Vercel HTTPS API"

        shipWithAli.web.portabilityOperations -> shipWithAli.web.contentPublishing "Processes cache invalidation and export-projection work without changing domain decisions" "In-process idempotent job handler"
        shipWithAli.web.portabilityOperations -> shipWithAli.web.measurement "Runs aggregation and retention jobs" "In-process idempotent job handler"
        shipWithAli.web.portabilityOperations -> shipWithAli.web.interactionModeration "Runs Feedback retention and aggregate repair jobs" "In-process idempotent job handler"
        shipWithAli.web.portabilityOperations -> shipWithAli.web.mediaLibrary "Runs media validation and recovery jobs" "In-process idempotent job handler"

        shipWithAli.web.measurement -> futureMeasurement "May be replaced after the measured analytics extraction trigger" "Versioned outbox events and HTTPS" {
            tags "Future"
        }
        shipWithAli.web.mediaLibrary -> futureMedia "May be replaced after the measured processing or backlog trigger" "Versioned outbox events and HTTPS" {
            tags "Future"
        }
        shipWithAli.web.interactionModeration -> futureInteractions "May be replaced after the measured sustained-write trigger" "Versioned outbox events and HTTPS" {
            tags "Future"
        }
        shipWithAli.web.taxonomyDiscovery -> futureSearch "May publish a read projection after the measured document-count and latency trigger" "Versioned outbox events and HTTPS" {
            tags "Future"
        }

        production = deploymentEnvironment "Production" {
            visitorDevice = deploymentNode "Visitor Device" "An untrusted desktop or mobile device." "Modern browser" {
                browser = infrastructureNode "Web Browser" "Runs progressively enhanced public or Owner UI code." "HTML, CSS, JavaScript"
            }

            vercel = deploymentNode "Vercel" "Managed edge delivery and serverless runtime." "Vercel" {
                cdn = infrastructureNode "CDN and Cache" "Terminates HTTPS and serves cached public responses and static assets." "Vercel CDN"
                runtime = deploymentNode "Application Runtime" "Runs the one modular-monolith deployment and authenticated scheduled entry points." "Vercel Functions" {
                    webInstance = containerInstance shipWithAli.web
                }
            }

            deploymentNode "Supabase" "Managed application data plane." "Supabase" {
                authInstance = softwareSystemInstance supabaseAuth
                deploymentNode "Database Runtime" "Hosts pooled PostgreSQL and Row Level Security." "Supabase PostgreSQL" {
                    databaseInstance = containerInstance shipWithAli.database
                }
                deploymentNode "Storage Runtime" "Hosts private candidates, accepted public variants, CVs, exports, and recovery artifacts." "Supabase Storage" {
                    storageInstance = containerInstance shipWithAli.objectStorage
                }
            }

            deploymentNode "GitHub Cloud" "Hosts identity and CI/CD capabilities." "GitHub" {
                oauthInstance = softwareSystemInstance githubOAuth
                actionsInstance = softwareSystemInstance githubActions
            }

            deploymentNode "Vercel Control Plane" "Hosts deployment, cache, and schedule controls." "Vercel" {
                vercelInstance = softwareSystemInstance vercelPlatform
            }

            deploymentNode "Resend Cloud" "Hosts transactional email delivery." "Resend" {
                resendInstance = softwareSystemInstance resend
            }

            deploymentNode "Sentry Cloud" "Hosts scrubbed error and trace ingestion." "Sentry" {
                sentryInstance = softwareSystemInstance sentry
            }

            visitorDevice.browser -> vercel.cdn "Requests public or Owner routes" "HTTPS"
            vercel.cdn -> vercel.runtime.webInstance "Serves cached responses or routes cache misses" "Vercel internal HTTPS"
        }
    }

    views {
        systemLandscape "SystemLandscape" "People, ShipWithAli, runtime providers, operational integrations, and public destinations." {
            include *
            exclude futureMeasurement futureMedia futureInteractions futureSearch
            autoLayout lr
        }

        systemContext shipWithAli "SystemContext" "The first-release ShipWithAli system and every direct person or external-system dependency." {
            include *
            exclude futureMeasurement futureMedia futureInteractions futureSearch
            autoLayout lr
        }

        container shipWithAli "Containers" "The one application deployment, owned data stores, people, and external dependencies." {
            include *
            exclude futureMeasurement futureMedia futureInteractions futureSearch
            autoLayout lr
        }

        component shipWithAli.web "Modules" "The nine deep domain modules, delivery surfaces, Provider Adapters, stores, and external integrations." {
            include *
            exclude futureMeasurement futureMedia futureInteractions futureSearch
            autoLayout lr
        }

        deployment shipWithAli production "ProductionDeployment" "Production mapping across Vercel, Supabase, GitHub, Resend, and Sentry." {
            include *
            autoLayout lr
        }

        dynamic shipWithAli.web "PublishLanguageVersion" "Reviewed publication, media validation, atomic persistence, outbox work, and cache invalidation." {
            owner -> shipWithAli.web.ownerWorkspace "Requests publication of one reviewed Language version"
            shipWithAli.web.ownerWorkspace -> shipWithAli.web.identityAccess "Requires the allowlisted Owner"
            shipWithAli.web.identityAccess -> shipWithAli.web.providerAdapters "Verifies the session"
            shipWithAli.web.providerAdapters -> supabaseAuth "Validates the GitHub-backed session"
            shipWithAli.web.ownerWorkspace -> shipWithAli.web.contentPublishing "Executes PublishLanguageVersion"
            shipWithAli.web.contentPublishing -> shipWithAli.web.mediaLibrary "Validates accepted Media references and accessibility metadata"
            shipWithAli.web.contentPublishing -> shipWithAli.web.taxonomyDiscovery "Validates controlled classifications and stages the public projection"
            shipWithAli.web.contentPublishing -> shipWithAli.web.providerAdapters "Atomically commits publication, route, projection, and outbox records"
            shipWithAli.web.providerAdapters -> shipWithAli.database "Commits the transaction"
            shipWithAli.web.portabilityOperations -> shipWithAli.web.providerAdapters "Leases the cache-invalidation job"
            shipWithAli.web.providerAdapters -> vercelPlatform "Invalidates stable identity and locale cache tags"
            autoLayout lr
        }

        dynamic shipWithAli.web "PublicRead" "Durable route resolution, published-language projection, discovery, configuration, and cached rendering." {
            visitor -> shipWithAli.web.publicExperience "Requests an English or Arabic public route"
            shipWithAli.web.publicExperience -> shipWithAli.web.contentPublishing "Resolves the route identity and Published Language version"
            shipWithAli.web.contentPublishing -> shipWithAli.web.providerAdapters "Queries the public read projection"
            shipWithAli.web.providerAdapters -> shipWithAli.database "Reads the current published projection and redirect history"
            shipWithAli.web.publicExperience -> shipWithAli.web.taxonomyDiscovery "Loads filters or a newest-published Project page"
            shipWithAli.web.taxonomyDiscovery -> shipWithAli.web.providerAdapters "Executes the indexed public query"
            shipWithAli.web.publicExperience -> shipWithAli.web.portfolioConfiguration "Loads public profile, Contact channels, and Global project CTA"
            shipWithAli.web.providerAdapters -> vercelPlatform "Stores or refreshes the tag-addressed response cache"
            autoLayout lr
        }

        dynamic shipWithAli.web "ModerateFeedback" "Private Feedback submission, deduplication, retained review history, and public eligibility." {
            visitor -> shipWithAli.web.publicExperience "Submits Feedback with an idempotency key"
            shipWithAli.web.publicExperience -> shipWithAli.web.interactionModeration "Validates and submits Feedback"
            shipWithAli.web.interactionModeration -> shipWithAli.web.identityAccess "Applies purpose and abuse policy"
            shipWithAli.web.interactionModeration -> shipWithAli.web.providerAdapters "Stores private pending Feedback and an outbox record"
            shipWithAli.web.providerAdapters -> shipWithAli.database "Commits the submission"
            owner -> shipWithAli.web.ownerWorkspace "Approves, rejects, or suppresses Feedback"
            shipWithAli.web.ownerWorkspace -> shipWithAli.web.identityAccess "Requires the allowlisted Owner"
            shipWithAli.web.ownerWorkspace -> shipWithAli.web.interactionModeration "Records the Moderation decision"
            shipWithAli.web.interactionModeration -> shipWithAli.web.providerAdapters "Atomically persists immutable history and public eligibility"
            autoLayout lr
        }

        dynamic shipWithAli.web "AnalyticsPipeline" "Consent validation, minimized event intake, durable aggregation, retention, and Owner reporting." {
            visitor -> shipWithAli.web.publicExperience "Consents and emits an allowlisted public event"
            shipWithAli.web.publicExperience -> shipWithAli.web.measurement "Records the event with an idempotency key"
            shipWithAli.web.measurement -> shipWithAli.web.identityAccess "Validates consent and analytics-purpose identity"
            shipWithAli.web.measurement -> shipWithAli.web.providerAdapters "Stores minimized event and aggregation work"
            shipWithAli.web.providerAdapters -> shipWithAli.database "Commits raw event and outbox records"
            vercelPlatform -> shipWithAli.web.portabilityOperations "Invokes a scheduled job batch"
            shipWithAli.web.portabilityOperations -> shipWithAli.web.measurement "Runs idempotent aggregation and retention"
            shipWithAli.web.measurement -> shipWithAli.web.providerAdapters "Writes daily aggregates and removes expired detail"
            owner -> shipWithAli.web.ownerWorkspace "Requests a goal-versioned report"
            shipWithAli.web.ownerWorkspace -> shipWithAli.web.measurement "Queries aggregates with Low-sample policy"
            autoLayout lr
        }

        dynamic shipWithAli.web "AcceptMedia" "Private upload preparation, object validation, metadata acceptance, and background work." {
            owner -> shipWithAli.web.ownerWorkspace "Requests a private upload grant"
            shipWithAli.web.ownerWorkspace -> shipWithAli.web.identityAccess "Requires the allowlisted Owner"
            shipWithAli.web.ownerWorkspace -> shipWithAli.web.mediaLibrary "Prepares a size-limited candidate upload"
            shipWithAli.web.mediaLibrary -> shipWithAli.web.providerAdapters "Creates the private object grant and candidate record"
            shipWithAli.web.providerAdapters -> shipWithAli.objectStorage "Stores the private candidate"
            owner -> shipWithAli.web.ownerWorkspace "Supplies required accessibility metadata and requests acceptance"
            shipWithAli.web.ownerWorkspace -> shipWithAli.web.mediaLibrary "Executes AcceptMediaAsset"
            shipWithAli.web.mediaLibrary -> shipWithAli.web.providerAdapters "Commits safety, ownership, suitability, accessibility, and outbox state"
            shipWithAli.web.portabilityOperations -> shipWithAli.web.mediaLibrary "Runs retry-safe validation or variant work"
            autoLayout lr
        }

        dynamic shipWithAli.web "ActivateCurrentCv" "Accepted-file validation and atomic Current CV replacement." {
            owner -> shipWithAli.web.ownerWorkspace "Requests activation of an accepted English CV version"
            shipWithAli.web.ownerWorkspace -> shipWithAli.web.identityAccess "Requires the allowlisted Owner"
            shipWithAli.web.ownerWorkspace -> shipWithAli.web.cvPortfolio "Executes ActivateCvVersion"
            shipWithAli.web.cvPortfolio -> shipWithAli.web.mediaLibrary "Confirms the file is an accepted English CV asset"
            shipWithAli.web.cvPortfolio -> shipWithAli.web.providerAdapters "Atomically replaces the Current CV designation and appends outbox work"
            shipWithAli.web.providerAdapters -> shipWithAli.database "Commits exactly one Current CV"
            visitor -> shipWithAli.web.publicExperience "Requests Current CV access"
            shipWithAli.web.publicExperience -> shipWithAli.web.cvPortfolio "Resolves the locale-appropriate result"
            shipWithAli.web.cvPortfolio -> shipWithAli.web.providerAdapters "Creates a short-lived signed download for the current asset"
            shipWithAli.web.providerAdapters -> shipWithAli.objectStorage "Reads the accepted Current CV object"
            autoLayout lr
        }

        dynamic shipWithAli.web "ProduceOwnerExport" "Portable export construction, integrity recording, storage, and recovery evidence." {
            owner -> shipWithAli.web.ownerWorkspace "Requests a versioned Owner export"
            shipWithAli.web.ownerWorkspace -> shipWithAli.web.identityAccess "Requires the allowlisted Owner"
            shipWithAli.web.ownerWorkspace -> shipWithAli.web.portabilityOperations "Creates an idempotent export request"
            shipWithAli.web.portabilityOperations -> shipWithAli.web.providerAdapters "Leases the export job and reads module-owned export projections"
            shipWithAli.web.providerAdapters -> shipWithAli.database "Reads eligible records under retention and privacy policy"
            shipWithAli.web.providerAdapters -> shipWithAli.objectStorage "Reads eligible media and CV objects"
            shipWithAli.web.portabilityOperations -> shipWithAli.web.providerAdapters "Writes the schema-versioned package, manifest, and checksums"
            shipWithAli.web.providerAdapters -> shipWithAli.objectStorage "Stores the encrypted export artifact"
            githubActions -> shipWithAli.database "Creates the nightly encrypted logical backup"
            githubActions -> shipWithAli.objectStorage "Creates the weekly encrypted storage artifact"
            autoLayout lr
        }

        systemContext shipWithAli "FutureExtraction" "Measured service-extraction candidates; none are active in the first release." {
            include shipWithAli
            include futureMeasurement
            include futureMedia
            include futureInteractions
            include futureSearch
            autoLayout lr
        }

        styles {
            element "Person" {
                shape Person
                background #08427b
                color #ffffff
            }
            element "Target System" {
                background #1168bd
                color #ffffff
            }
            element "Application" {
                shape RoundedBox
                background #438dd5
                color #ffffff
            }
            element "Database" {
                shape Cylinder
                background #2e7d32
                color #ffffff
            }
            element "Storage" {
                shape Folder
                background #2e7d32
                color #ffffff
            }
            element "Module" {
                shape Component
                background #85bbf0
                color #0b2540
            }
            element "Adapter" {
                shape Hexagon
                background #6c757d
                color #ffffff
            }
            element "External" {
                background #999999
                color #ffffff
            }
            element "Future" {
                background #fff3cd
                color #664d03
                opacity 60
            }
            element "Restricted" {
                stroke #9c1c1c
                strokeWidth 3
            }
            relationship "Future" {
                dashed true
                color #8a6d3b
            }
        }

        theme default
    }

    configuration {
        scope softwaresystem
    }
}
