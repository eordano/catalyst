import fetch from "node-fetch"
import FormData from "form-data"
import { Server } from "@katalyst/content/Server"
import { Environment, EnvironmentConfig, Bean } from "@katalyst/content/Environment"
import { ServerAddress, ContentServerClient } from "@katalyst/content/service/synchronization/clients/contentserver/ContentServerClient"
import { EntityType, Pointer, EntityId } from "@katalyst/content/service/Entity"
import { ControllerEntity } from "@katalyst/content/controller/Controller"
import { PartialDeploymentHistory } from "@katalyst/content/service/history/HistoryManager"
import { ContentFileHash } from "@katalyst/content/service/Hashing"
import { DeployData, hashAndSignMessage, Identity, parseEntityType } from "./E2ETestUtils"
import { ContentFile, ServerStatus } from "@katalyst/content/service/Service"
import { Timestamp } from "@katalyst/content/service/time/TimeSorting"
import { AuditInfo } from "@katalyst/content/service/audit/Audit"
import { getClient } from "@katalyst/content/service/synchronization/clients/contentserver/ActiveContentServerClient"
import { buildEntityTarget, DenylistTarget, buildContentTarget } from "@katalyst/content/denylist/DenylistTarget"
import { FailedDeployment } from "@katalyst/content/service/errors/FailedDeploymentsManager"
import { assertResponseIsOkOrThrow } from "./E2EAssertions"
import { FetchHelper } from "@katalyst/content/helpers/FetchHelper"

/** A wrapper around a server that helps make tests more easily */
export class TestServer extends Server {

    private serverPort: number
    private started: boolean = false
    public readonly namePrefix: string
    public readonly storageFolder: string

    private readonly client: ContentServerClient

    constructor(env: Environment) {
        super(env)
        this.serverPort = env.getConfig(EnvironmentConfig.SERVER_PORT)
        this.namePrefix = env.getConfig(EnvironmentConfig.NAME_PREFIX)
        this.storageFolder = env.getConfig(EnvironmentConfig.STORAGE_ROOT_FOLDER)
        const fetchHelper: FetchHelper = env.getBean(Bean.FETCH_HELPER)
        const requestTtlBackwards: number = env.getConfig(EnvironmentConfig.REQUEST_TTL_BACKWARDS)
        this.client = getClient(fetchHelper, this.getAddress(), requestTtlBackwards, this.namePrefix, 0)
    }

    getAddress(): ServerAddress {
        return `http://localhost:${this.serverPort}`
    }

    start(): Promise<void> {
        this.started = true
        return super.start()
    }

    stop(): Promise<void> {
        if (this.started) {
            return super.stop()
        } else {
            return Promise.resolve()
        }
    }

    async deploy(deployData: DeployData, fix: boolean = false): Promise<Timestamp> {
        const form = new FormData();
        form.append('entityId'  , deployData.entityId)
        form.append('ethAddress', deployData.ethAddress)
        form.append('signature' , deployData.signature)
        deployData.files.forEach((f: ContentFile) => form.append(f.name, f.content, { filename: f.name }))

        const deployResponse = await fetch(`${this.getAddress()}/entities${fix ? '?fix=true' : ''}`, { method: 'POST', body: form })
        if (deployResponse.ok) {
            const { creationTimestamp } = await deployResponse.json()
            return creationTimestamp
        } else {
            const errorMessage = await deployResponse.text()
            throw new Error(errorMessage)
        }
    }

    getFailedDeployments(): Promise<FailedDeployment[]> {
        return this.makeRequest(`${this.getAddress()}/failedDeployments`)
    }

    async getEntitiesByPointers(type: EntityType, pointers: Pointer[]): Promise<ControllerEntity[]> {
        const filterParam = pointers.map(pointer => `pointer=${pointer}`).join("&")
        return this.makeRequest(`${this.getAddress()}/entities/${type}?${filterParam}`)
    }

    getHistory(): Promise<PartialDeploymentHistory> {
        return this.makeRequest(`${this.getAddress()}/history`)
    }

    getStatus(): Promise<ServerStatus> {
        return this.client.getStatus()
    }

    getEntitiesByIds(type: string, ...ids: EntityId[]): Promise<ControllerEntity[]> {
        const filterParam = ids.map(id => `id=${id}`).join("&")
        return this.makeRequest(`${this.getAddress()}/entities/${type}?${filterParam}`)
    }

    async getEntityById(type: string, id: EntityId): Promise<ControllerEntity> {
        const entities: ControllerEntity[] = await this.getEntitiesByIds(type, id)
        expect(entities.length).toEqual(1)
        expect(entities[0].id).toEqual(id)
        return entities[0]
    }

    async downloadContent(fileHash: ContentFileHash): Promise<Buffer> {
        const response = await fetch(`${this.getAddress()}/contents/${fileHash}`);
        if (response.ok) {
            return await response.buffer();
        }

        throw new Error(`Failed to fetch file with hash ${fileHash} on server ${this.namePrefix}`)
    }

    async getAuditInfo(entity: ControllerEntity): Promise<AuditInfo> {
        return this.client.getAuditInfo(parseEntityType(entity), entity.id)
    }

    denylistEntity(entity: ControllerEntity, identity: Identity): Promise<void> {
        const entityTarget = buildEntityTarget(EntityType[entity.type.toUpperCase().trim()], entity.id)
        return this.denylistTarget(entityTarget, identity)
    }

    undenylistEntity(entity: ControllerEntity, identity: Identity): Promise<void> {
        const entityTarget = buildEntityTarget(EntityType[entity.type.toUpperCase().trim()], entity.id)
        return this.undenylistTarget(entityTarget, identity)
    }

    async denylistContent(fileHash: ContentFileHash, identity: Identity): Promise<void> {
        const contentTarget = buildContentTarget(fileHash)
        return this.denylistTarget(contentTarget, identity)
    }

    private async denylistTarget(target: DenylistTarget, identity: Identity) {
        const timestamp = Date.now()
        const [address, signature] = hashAndSignMessage(`${target.asString()}${timestamp}`, identity)

        const body = {
            "timestamp": timestamp,
            "blocker": address,
            "signature": signature
        }

        const deployResponse = await fetch(`${this.getAddress()}/denylist/${target.getType()}/${target.getId()}`, { method: 'PUT', body: JSON.stringify(body), headers: {"Content-Type": "application/json"} })
        await assertResponseIsOkOrThrow(deployResponse)
    }

    private async undenylistTarget(target: DenylistTarget, identity: Identity) {
        const timestamp = Date.now()
        const [address, signature] = hashAndSignMessage(`${target.asString()}${timestamp}`, identity)
        const query = `blocker=${address}&timestamp=${timestamp}&signature=${signature}`
        const deployResponse = await fetch(`${this.getAddress()}/denylist/${target.getType()}/${target.getId()}?${query}`, { method: 'DELETE', headers: {"Content-Type": "application/json"} })
        await assertResponseIsOkOrThrow(deployResponse)
    }

    private async makeRequest(url: string): Promise<any> {
        const response = await fetch(url)
        expect(response.ok).toBe(true, `The request to ${url} failed`)
        return response.json();
    }

}