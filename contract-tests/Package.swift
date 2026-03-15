// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ContractTests",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "SleepypodModels",
            path: "Sources/SleepypodModels"
        ),
        .testTarget(
            name: "ContractTests",
            dependencies: ["SleepypodModels"],
            path: "Tests/ContractTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
