import Foundation
import Testing
@testable import SleepypodModels

/// Loads a JSON fixture file from the Fixtures/ resource bundle.
private func loadFixture(_ name: String) throws -> Data {
    guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") else {
        throw NSError(
            domain: "ContractTests",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Missing fixture: \(name).json in Fixtures/"]
        )
    }
    return try Data(contentsOf: url)
}

// MARK: - Healthcheck

@Test func healthcheckDecodes() throws {
    let data = try loadFixture("healthcheck")
    let result = try JSONDecoder().decode(String.self, from: data)
    #expect(result == "yay!")
}

// MARK: - System

@Test func diskUsageDecodes() throws {
    struct DiskUsage: Codable {
        var totalBytes: Int
        var usedBytes: Int
        var availableBytes: Int
        var usedPercent: Double
    }
    let data = try loadFixture("disk-usage")
    let result = try JSONDecoder().decode(DiskUsage.self, from: data)
    #expect(result.usedPercent >= 0)
    #expect(result.usedPercent <= 100)
}

@Test func internetStatusDecodes() throws {
    struct InternetStatus: Codable {
        var blocked: Bool
    }
    let data = try loadFixture("internet-status")
    _ = try JSONDecoder().decode(InternetStatus.self, from: data)
}

@Test func wifiStatusDecodes() throws {
    struct WifiStatus: Codable {
        var connected: Bool
        var ssid: String?
        var signal: Int?
    }
    let data = try loadFixture("wifi-status")
    _ = try JSONDecoder().decode(WifiStatus.self, from: data)
}

// MARK: - Biometrics

@Test func processingStatusDecodes() throws {
    struct ProcessingStatus: Codable {
        var iosProcessingActive: Bool
        var connectedSince: Int?
    }
    let data = try loadFixture("processing-status")
    _ = try JSONDecoder().decode(ProcessingStatus.self, from: data)
}

@Test func fileCountDecodes() throws {
    struct FileCount: Codable {
        struct RawFiles: Codable {
            var left: Int
            var right: Int
        }
        var rawFiles: RawFiles
        var totalSizeMB: Double
    }
    let data = try loadFixture("file-count")
    _ = try JSONDecoder().decode(FileCount.self, from: data)
}

@Test func sleepRecordsDecodes() throws {
    let data = try loadFixture("sleep-records")
    _ = try JSONDecoder().decode([SleepRecord].self, from: data)
}

@Test func vitalsDecodes() throws {
    let data = try loadFixture("vitals")
    _ = try JSONDecoder().decode([VitalsRecord].self, from: data)
}

@Test func movementDecodes() throws {
    let data = try loadFixture("movement")
    _ = try JSONDecoder().decode([MovementRecord].self, from: data)
}

// MARK: - Health

@Test func healthSystemDecodes() throws {
    struct HealthSystem: Codable {
        var status: String
        var timestamp: String
    }
    let data = try loadFixture("health-system")
    let result = try JSONDecoder().decode(HealthSystem.self, from: data)
    #expect(result.status == "ok" || result.status == "degraded")
}

@Test func healthSchedulerDecodes() throws {
    struct HealthScheduler: Codable {
        var enabled: Bool
        var healthy: Bool
    }
    let data = try loadFixture("health-scheduler")
    _ = try JSONDecoder().decode(HealthScheduler.self, from: data)
}
