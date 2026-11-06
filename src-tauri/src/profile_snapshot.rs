use crate::bindings::BindingKey;
use crate::model::{Binding, MidiMessageType, Profile};
use std::collections::HashMap;
use std::ops::Deref;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ControlKey {
    channel: u8,
    controller: u8,
    msg_type: MidiMessageType,
}

impl From<&Binding> for ControlKey {
    fn from(binding: &Binding) -> Self {
        Self {
            channel: binding.control.channel,
            controller: binding.control.controller,
            msg_type: binding.control.msg_type.clone(),
        }
    }
}

impl From<&BindingKey> for ControlKey {
    fn from(key: &BindingKey) -> Self {
        Self {
            channel: key.channel,
            controller: key.controller,
            msg_type: key.msg_type.clone(),
        }
    }
}

/// Immutable active-profile state with precomputed MIDI lookup tables.
///
/// Runtime readers clone an `Arc<ProfileSnapshot>`, avoiding a deep profile
/// clone for every MIDI event or feedback refresh. Writers build and publish a
/// fresh snapshot only after a profile mutation succeeds.
#[derive(Debug)]
pub(crate) struct ProfileSnapshot {
    profile: Profile,
    exact_bindings: HashMap<BindingKey, usize>,
    fallback_bindings: HashMap<ControlKey, Option<usize>>,
    allow_single_device_fallback: bool,
}

impl ProfileSnapshot {
    pub(crate) fn new(profile: Profile) -> Self {
        let mut exact_bindings = HashMap::with_capacity(profile.bindings.len());
        let mut fallback_bindings = HashMap::with_capacity(profile.bindings.len());
        for (index, binding) in profile.bindings.iter().enumerate() {
            exact_bindings
                .entry(BindingKey::from_binding(binding))
                .or_insert(index);
            fallback_bindings
                .entry(ControlKey::from(binding))
                .and_modify(|candidate| *candidate = None)
                .or_insert(Some(index));
        }
        Self {
            allow_single_device_fallback: crate::midi_reconciliation::allows_single_device_fallback(
                &profile,
            ),
            profile,
            exact_bindings,
            fallback_bindings,
        }
    }

    pub(crate) fn profile(&self) -> &Profile {
        &self.profile
    }

    pub(crate) fn find_binding(
        &self,
        key: &BindingKey,
        allow_stale_device_fallback: bool,
    ) -> Option<&Binding> {
        if let Some(index) = self.exact_bindings.get(key) {
            return self.profile.bindings.get(*index);
        }
        if !allow_stale_device_fallback || !self.allow_single_device_fallback {
            return None;
        }
        let index = self
            .fallback_bindings
            .get(&ControlKey::from(key))?
            .as_ref()?;
        self.profile.bindings.get(*index)
    }
}

impl Deref for ProfileSnapshot {
    type Target = Profile;

    fn deref(&self) -> &Self::Target {
        &self.profile
    }
}
