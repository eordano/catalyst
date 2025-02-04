import ms from "ms"
import { buildEvent, assertHistoryOnServerHasEvents, assertEntityIsNotDenylisted, assertContentNotIsDenylisted, assertFieldsOnEntitiesExceptIdsAreEqual, assertFileIsOnServer, assertEntityWasNotDeployed } from "../E2EAssertions"
import { Environment, EnvironmentConfig } from "@katalyst/content/Environment"
import { DAOClient } from "decentraland-katalyst-commons/DAOClient"
import { Timestamp } from "@katalyst/content/service/time/TimeSorting"
import { ControllerEntityContent } from "@katalyst/content/controller/Controller"
import { ContentFileHash } from "@katalyst/content/service/Hashing"
import { MockedDAOClient } from "@katalyst/test-helpers/service/synchronization/clients/MockedDAOClient"
import { TestServer } from "../TestServer"
import { buildBaseEnv, buildDeployData, deleteServerStorage, createIdentity, awaitUntil } from "../E2ETestUtils"


describe("End 2 end - Denylist handling", () => {

    const DAO = MockedDAOClient.withAddresses('http://localhost:6060', 'http://localhost:7070', 'http://localhost:8080')
    const identity = createIdentity()
    const SYNC_INTERVAL: number = ms("5s")
    let server1: TestServer, server2: TestServer, onboardingServer: TestServer

    beforeEach(async () => {
        server1 = await buildServer("Server1_", 6060, SYNC_INTERVAL, DAO)
        server2 = await buildServer("Server2_", 7070, SYNC_INTERVAL, DAO)
        onboardingServer = await buildServer("OnboardingServer_", 8080, SYNC_INTERVAL, DAO)
    })

    afterEach(async function() {
        await server1.stop()
        await server2.stop()
        await onboardingServer.stop()
        deleteServerStorage(server1, server2, onboardingServer)
    })

    it(`When an entity is denylisted across all nodes, then no entity is deployed`, async () => {
        // Start server 1
        await server1.start()

        // Prepare entity to deploy
        const [deployData, entityBeingDeployed] = await buildDeployData(["0,0", "0,1"], 'metadata')

        // Deploy the entity
        const deploymentTimestamp: Timestamp = await server1.deploy(deployData)
        const deploymentEvent = buildEvent(entityBeingDeployed, server1, deploymentTimestamp)

        // Black list the entity
        await server1.denylistEntity(entityBeingDeployed, identity)

        // Start onboarding server
        await onboardingServer.start()

        // Wait for servers to sync and assert on onboarding server has all history
        await awaitUntil(() => assertHistoryOnServerHasEvents(onboardingServer, deploymentEvent))

        // Assert it wasn't deployed
        await assertEntityWasNotDeployed(onboardingServer, entityBeingDeployed)
    });

    it(`When content is denylisted across all nodes, then no entity is deployed`, async () => {
        // Start server 1
        await server1.start()

        // Prepare entity to deploy
        const [deployData, entityBeingDeployed] = await buildDeployData(["0,0", "0,1"], 'metadata', 'content/test/integration/resources/some-binary-file.png')
        const contentHash: ContentFileHash = (entityBeingDeployed.content as ControllerEntityContent[])[0].hash

        // Deploy the entity
        const deploymentTimestamp: Timestamp = await server1.deploy(deployData)
        const deploymentEvent = buildEvent(entityBeingDeployed, server1, deploymentTimestamp)

        // Black list the entity
        await server1.denylistContent(contentHash, identity)

        // Start onboarding server
        await onboardingServer.start()

        // Wait for servers to sync and assert on onboarding server has all history
        await awaitUntil(() => assertHistoryOnServerHasEvents(onboardingServer, deploymentEvent))

        // Assert it wasn't deployed
        await assertEntityWasNotDeployed(onboardingServer, entityBeingDeployed)
    });

    it(`When an entity is denylisted in some nodes, then onboarding node can still get it`, async () => {
        // Start server 1 and 2
        await Promise.all([server1.start(), server2.start()])

        // Prepare entity to deploy
        const [deployData, entityBeingDeployed] = await buildDeployData(["0,0", "0,1"], 'metadata', 'content/test/integration/resources/some-binary-file.png')

        // Deploy the entity
        const deploymentTimestamp: Timestamp = await server1.deploy(deployData)
        const deploymentEvent = buildEvent(entityBeingDeployed, server1, deploymentTimestamp)

        // Wait for servers to sync
        await awaitUntil(() => assertHistoryOnServerHasEvents(server2, deploymentEvent))

        // Black list the entity
        await server1.denylistEntity(entityBeingDeployed, identity)

        // Start onboarding server
        await onboardingServer.start()

        // Wait for servers to sync and assert entity is not denylisted on onboarding server
        await awaitUntil(() => assertEntityIsNotDenylisted(onboardingServer, entityBeingDeployed))

        // Assert on onboarding server has all history
        await assertHistoryOnServerHasEvents(onboardingServer, deploymentEvent)

        // Assert the entity is retrieved correctly
        const entity = await onboardingServer.getEntityById(entityBeingDeployed.type, entityBeingDeployed.id)
        expect(entity).toEqual(entityBeingDeployed)

        // Assert entity file matches the deployed entity
        const fileContent = await onboardingServer.downloadContent(entity.id)
        assertFieldsOnEntitiesExceptIdsAreEqual(JSON.parse(fileContent.toString()), entityBeingDeployed)
    });

    it(`When content is denylisted in some nodes, then onboarding node can still get it`, async () => {
        // Start server 1 and 2
        await Promise.all([server1.start(), server2.start()])

        // Prepare entity to deploy
        const [deployData, entityBeingDeployed] = await buildDeployData(["0,0", "0,1"], 'metadata', 'content/test/integration/resources/some-binary-file.png')
        const contentHash: ContentFileHash = (entityBeingDeployed.content as ControllerEntityContent[])[0].hash

        // Deploy the entity
        const deploymentTimestamp: Timestamp = await server1.deploy(deployData)
        const deploymentEvent = buildEvent(entityBeingDeployed, server1, deploymentTimestamp)

        // Wait for servers to sync
        await awaitUntil(() => assertHistoryOnServerHasEvents(server2, deploymentEvent))

        // Black list the entity
        await server1.denylistContent(contentHash, identity)

        // Start onboarding server
        await onboardingServer.start()

        // Wait for servers to sync and assert content is not denylisted on onboarding server
        await awaitUntil(() => assertContentNotIsDenylisted(onboardingServer, entityBeingDeployed, contentHash))

        // Assert on onboarding server has all history
        await assertHistoryOnServerHasEvents(onboardingServer, deploymentEvent)

        // Assert the entity is retrieved correctly
        const entity = await onboardingServer.getEntityById(entityBeingDeployed.type, entityBeingDeployed.id)
        expect(entity).toEqual(entityBeingDeployed)

        // Assert content is available
        await assertFileIsOnServer(onboardingServer, contentHash)
    });

    async function buildServer(namePrefix: string, port: number, syncInterval: number, daoClient: DAOClient) {
        const env: Environment = await buildBaseEnv(namePrefix, port, syncInterval, daoClient)
            .withConfig(EnvironmentConfig.DECENTRALAND_ADDRESS, identity.address)
            .build()
        return new TestServer(env)
    }
})