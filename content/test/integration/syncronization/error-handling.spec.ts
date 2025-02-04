import ms from "ms"
import { buildEvent, assertEqualsDeployment, assertEntityWasNotDeployed, assertEntitiesAreActiveOnServer, assertHistoryOnServerHasEvents, assertEntitiesAreDeployedButNotActive } from "../E2EAssertions"
import { Environment, EnvironmentConfig } from "@katalyst/content/Environment"
import { DAOClient } from "decentraland-katalyst-commons/DAOClient";
import { Timestamp } from "@katalyst/content/service/time/TimeSorting"
import { ControllerEntity } from "@katalyst/content/controller/Controller"
import { MockedDAOClient } from "@katalyst/test-helpers/service/synchronization/clients/MockedDAOClient"
import { TestServer } from "../TestServer"
import { buildBaseEnv, buildDeployData, deleteServerStorage, createIdentity, buildDeployDataAfterEntity, stopServers, awaitUntil } from "../E2ETestUtils"
import { FailedDeployment, FailureReason } from "@katalyst/content/service/errors/FailedDeploymentsManager"
import { MockedAccessChecker } from "@katalyst/test-helpers/service/access/MockedAccessChecker"
import { assertPromiseRejectionIs } from "@katalyst/test-helpers/PromiseAssertions"


describe("End 2 end - Error handling", () => {

    const DAO = MockedDAOClient.withAddresses('http://localhost:6060', 'http://localhost:7070')
    const identity = createIdentity()
    const SYNC_INTERVAL: number = ms("5s")
    let server1: TestServer, server2: TestServer
    let accessChecker = new MockedAccessChecker()

    beforeEach(async () => {
        server1 = await buildServer("Server1_", 6060, SYNC_INTERVAL, DAO)
        server2 = await buildServer("Server2_", 7070, SYNC_INTERVAL, DAO)
    })

    afterEach(async function() {
        await stopServers(server1, server2)
        deleteServerStorage(server1, server2)
    })

    it(`When entity can't be retrieved, then the error is recorded and no entity is created`, async () => {
        await runTest(FailureReason.NO_ENTITY_OR_AUDIT,
            entity => server1.denylistEntity(entity, identity))
    });

    it(`When content can't be retrieved, then the error is recorded and no entity is created`, async () => {
        await runTest(FailureReason.FETCH_PROBLEM,
            entity => server1.denylistContent(entity.content!![0].hash, identity))
    });

    it(`When an error happens during deployment, then the error is recorded and no entity is created`, async () => {
        await runTest(FailureReason.DEPLOYMENT_ERROR,
            _ => { accessChecker.startReturningErrors(); return Promise.resolve() },
            () => { accessChecker.stopReturningErrors(); return Promise.resolve() })
    });

    it(`When a user tries to fix an entity, it doesn't matter if there is already a newer entity deployed`, async () => {
        // Start servers
        await server1.start()
        await server2.start()

        // Prepare entity to deploy
        const [deployData1, entityBeingDeployed1] = await buildDeployData(["0,0", "0,1"], 'metadata', 'content/test/integration/resources/some-binary-file.png')
        const entity1Content = entityBeingDeployed1.content!![0].hash

        // Deploy entity 1
        const deploymentTimestamp = await server1.deploy(deployData1)
        const deploymentEvent = buildEvent(entityBeingDeployed1, server1, deploymentTimestamp)

        // Cause sync failure
        await server1.denylistContent(entity1Content, identity)

        // Wait for servers to sync
        await awaitUntil(async () => await assertHistoryOnServerHasEvents(server2, deploymentEvent))

        // Assert deployment is marked as failed on server 2
        const failedDeployments: FailedDeployment[] = await server2.getFailedDeployments()
        expect(failedDeployments.length).toBe(1)

        // Prepare entity to deploy
        const [deployData2, entityBeingDeployed2] = await buildDeployDataAfterEntity(["0,1"], 'metadata2', entityBeingDeployed1)

        // Deploy entity 2 on server 2
        await server2.deploy(deployData2)

        // Fix entity 1 on server 2
        await server2.deploy(deployData1, true)

        // Assert there are no more failed deployments
        const newFailedDeployments: FailedDeployment[] = await server2.getFailedDeployments()
        expect(newFailedDeployments.length).toBe(0)

        // Wait for servers to sync and assert entity 2 is the active entity on both servers
        await awaitUntil(() => assertEntitiesAreActiveOnServer(server1, entityBeingDeployed2))
        await assertEntitiesAreActiveOnServer(server2, entityBeingDeployed2)
        await assertEntitiesAreDeployedButNotActive(server1, entityBeingDeployed1)
        await assertEntitiesAreDeployedButNotActive(server2, entityBeingDeployed1)
    });

    it(`When a user tries to fix an entity that didn't exist, then an error is thrown`, async () => {
        // Start server
        await server1.start()

        // Prepare entity to deploy
        const [deployData] = await buildDeployData(["0,0", "0,1"], 'metadata')

        // Try to deploy the entity, and fail
        await assertPromiseRejectionIs(() => server1.deploy(deployData, true), "You are trying to fix an entity that is not marked as failed")
    });

    it(`When a user tries to fix an entity that hadn't fail, then an error is thrown`, async () => {
        // Start server
        await server1.start()

        // Prepare entity to deploy
        const [deployData] = await buildDeployData(["0,0", "0,1"], 'metadata')

        // Deploy the entity
        await server1.deploy(deployData)

        // Try to fix the entity, and fail
        await assertPromiseRejectionIs(() => server1.deploy(deployData, true), "This entity was already deployed. You can't redeploy it\nYou are trying to fix an entity that is not marked as failed")
    });

    async function runTest(errorType: FailureReason, causeOfFailure: (entity: ControllerEntity) => Promise<void>, removeCauseOfFailure?: () => Promise<void>, ) {
        // Start servers
        await server1.start()
        await server2.start()

        // Prepare entity to deploy
        const [deployData, entityBeingDeployed] = await buildDeployData(["0,0", "0,1"], 'metadata', 'content/test/integration/resources/some-binary-file.png')

        // Deploy the entity
        const deploymentTimestamp: Timestamp = await server1.deploy(deployData)
        const deploymentEvent = buildEvent(entityBeingDeployed, server1, deploymentTimestamp)

        // Cause failure
        await causeOfFailure(entityBeingDeployed)

        // Wait for servers to sync
        await awaitUntil(async () => await assertHistoryOnServerHasEvents(server2, deploymentEvent))

        // Assert deployment is marked as failed
        const failedDeployments: FailedDeployment[] = await server2.getFailedDeployments()
        expect(failedDeployments.length).toBe(1)
        assertEqualsDeployment(failedDeployments[0].deployment, deploymentEvent)
        expect(failedDeployments[0].reason).toEqual(errorType)
        expect(failedDeployments[0].moment).toBeGreaterThan(entityBeingDeployed.timestamp)

        // Assert entity wasn't deployed
        await assertEntityWasNotDeployed(server2, entityBeingDeployed)

        // Assert history was still modified
        await assertHistoryOnServerHasEvents(server2, deploymentEvent)

        // Assert immutable time is more recent than the entity
        const immutableTime = await server2.getStatus().then(status => status.lastImmutableTime)
        expect(immutableTime).toBeGreaterThan(0)

        // Remove cause of failure
        if (removeCauseOfFailure)
            await removeCauseOfFailure()

        // Fix the entity
        await server2.deploy(deployData, true)

        // Assert there are no more failed deployments
        const newFailedDeployments: FailedDeployment[] = await server2.getFailedDeployments()
        expect(newFailedDeployments.length).toBe(0)

        // Assert entity is there
        await assertEntitiesAreActiveOnServer(server2, entityBeingDeployed)
    }

    async function buildServer(namePrefix: string, port: number, syncInterval: number, daoClient: DAOClient) {
        const env: Environment = await buildBaseEnv(namePrefix, port, syncInterval, daoClient)
            .withConfig(EnvironmentConfig.DECENTRALAND_ADDRESS, identity.address)
            .withConfig(EnvironmentConfig.REQUEST_TTL_BACKWARDS, ms('5s'))
            .withAccessChecker(accessChecker)
            .build()
        return new TestServer(env)
    }
})