import Foundation

/// A dashboard chart's bars on one track (0 to 1): where the zero line sits
/// and where each bar starts and how long it is. A negative value runs from
/// zero toward the start, a positive one toward the end, so a loss never
/// reads as a small gain.
public enum ChartBars {
    public struct Bar: Sendable, Hashable {
        public var start: Double
        public var length: Double
    }

    /// The zero line's place: 0 when nothing is negative, 1 when nothing is positive.
    public static func zero(_ values: [Double]) -> Double {
        let (low, high) = range(values)
        return high > low ? -low / (high - low) : 0
    }

    public static func bar(_ value: Double, in values: [Double]) -> Bar {
        let (low, high) = range(values)
        guard high > low else { return Bar(start: 0, length: 0) }
        let zero = -low / (high - low)
        let length = abs(value) / (high - low)
        return Bar(start: value < 0 ? zero - length : zero, length: length)
    }

    private static func range(_ values: [Double]) -> (Double, Double) {
        (min(0, values.min() ?? 0), max(0, values.max() ?? 0))
    }
}
