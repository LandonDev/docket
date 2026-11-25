//! Primary display changes (§29.9). The policy runs over a fake on the box.

use crate::contract::{display, DISPLAY_SCALE_STEPS};
use crate::desktop::fail;
use crate::wire::{
    ComputerError, ComputerErrorKind, DisplayGetResult, DisplaySetParams, DisplaySetResult,
};

pub trait DisplayAdapter {
    type Source;

    fn primary(&self) -> Result<Primary<Self::Source>, ComputerError>;
    fn is_viogpudo(&self, source: &Self::Source) -> bool;
    fn resize(
        &self,
        source: &mut Self::Source,
        width: u16,
        height: u16,
    ) -> Result<bool, ComputerError>;
    fn set_scale(&self, source: &Self::Source, relative: i32);
}

pub struct Primary<S> {
    pub source: S,
    pub mode: DisplayGetResult,
    pub dpi: DpiSteps,
}

/// Windows numbers the scale steps relative to the recommended one. Its
/// minimum is the offset from the recommended step back to 100%.
#[derive(Clone, Copy)]
pub struct DpiSteps {
    pub min: i32,
    pub current: i32,
    pub max: i32,
}

impl DpiSteps {
    pub fn percent(&self) -> Option<i64> {
        let index = self.current.checked_sub(self.min)?;
        DISPLAY_SCALE_STEPS
            .get(usize::try_from(index).ok()?)
            .copied()
    }

    fn relative(&self, percent: i64) -> Option<i32> {
        let index = DISPLAY_SCALE_STEPS
            .iter()
            .position(|&step| step == percent)? as i32;
        let relative = self.min.checked_add(index)?;
        (self.min..=self.max)
            .contains(&relative)
            .then_some(relative)
    }
}

pub(crate) fn validate(ask: &DisplaySetParams) -> Result<(), &'static str> {
    if !(display::MIN_WIDTH..=display::MAX_WIDTH).contains(&ask.width)
        || !(display::MIN_HEIGHT..=display::MAX_HEIGHT).contains(&ask.height)
        || ask.width % 2 != 0
        || ask.height % 2 != 0
    {
        return Err("width and height must be even and within 1024×640 to 4096×2400");
    }
    if !DISPLAY_SCALE_STEPS.contains(&ask.scale) {
        return Err("scale must be a Windows DPI step");
    }
    Ok(())
}

/** The name viogpudo's INF gives its adapter; with Microsoft's fallback driver on the same device it reads "Microsoft Basic Display Adapter". */
pub const VIOGPUDO_ADAPTER: &str = "Red Hat VirtIO GPU DOD controller";

/**
 * Whether the primary display runs on viogpudo: the device's service says so, or the adapter carries viogpudo's own
 * name. On a real guest the service lookup failed while the adapter was viogpudo's (a scratch machine, Nov 25), and
 * the name comes from the bound driver's INF, so a fallback driver on the same PCI device never matches it.
 */
fn drives_viogpudo<A: DisplayAdapter>(adapter: &A, primary: &Primary<A::Source>) -> bool {
    adapter.is_viogpudo(&primary.source) || primary.mode.adapter == VIOGPUDO_ADAPTER
}

pub fn get(adapter: &impl DisplayAdapter) -> Result<DisplayGetResult, ComputerError> {
    Ok(adapter.primary()?.mode)
}

pub fn set(
    adapter: &impl DisplayAdapter,
    ask: DisplaySetParams,
) -> Result<DisplaySetResult, ComputerError> {
    let require_virtio = |primary: &Primary<_>| {
        if drives_viogpudo(adapter, primary) {
            Ok(())
        } else {
            Err(fail(
                ComputerErrorKind::ActionUnsupported,
                format!(
                    "display.set requires viogpudo on the primary display (found {})",
                    primary.mode.adapter
                ),
            ))
        }
    };
    let mut primary = adapter.primary()?;
    require_virtio(&primary)?;
    let size_matches =
        |mode: &DisplayGetResult| (mode.width, mode.height) == (ask.width, ask.height);
    let resized = !size_matches(&primary.mode);
    let mut applied = true;
    if resized {
        applied = adapter.resize(&mut primary.source, ask.width as u16, ask.height as u16)?;
        primary = adapter.primary()?;
    }
    if applied && size_matches(&primary.mode) && primary.mode.scale != ask.scale {
        if let Some(relative) = primary.dpi.relative(ask.scale) {
            if !resized || drives_viogpudo(adapter, &primary) {
                adapter.set_scale(&primary.source, relative);
                primary = adapter.primary()?;
            }
        }
    }
    let DisplayGetResult {
        width,
        height,
        scale,
        adapter,
    } = primary.mode;
    let taken = applied && (width, height, scale) == (ask.width, ask.height, ask.scale);
    Ok(DisplaySetResult {
        width,
        height,
        scale,
        adapter,
        taken,
    })
}
