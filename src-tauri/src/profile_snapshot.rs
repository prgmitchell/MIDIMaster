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
        if !allow_stale_device_fallback {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        BindingAction, BindingControlKind, BindingTarget, MidiControl, MidiMessageType, MidiMode,
    };

    fn binding(id: &str, device_id: &str, controller: u8) -> Binding {
        Binding {
            id: id.to_string(),
            name: id.to_string(),
            device_id: device_id.to_string(),
            control: MidiControl {
                channel: 0,
                controller,
                msg_type: MidiMessageType::ControlChange,
            },
            control_kind: BindingControlKind::Continuous,
            targets: vec![BindingTarget::Master],
            target: BindingTarget::Master,
            action: BindingAction::Volume,
            mode: MidiMode::Absolute,
            ..crate::test_support::binding()
        }
    }

    fn key(device_id: &str, controller: u8) -> BindingKey {
        BindingKey {
            device_id: device_id.to_string(),
            channel: 0,
            controller,
            msg_type: MidiMessageType::ControlChange,
        }
    }

    #[test]
    fn exact_and_unique_stale_device_lookups_are_indexed() {
        let mut profile = Profile {
            name: "indexed".to_string(),
            bindings: vec![binding("one", "midi:0", 7)],
            osd_settings: Default::default(),
            plugin_settings: Default::default(),
            midi_device_preference: Default::default(),
            midi_device_preference_set: false,
        };
        profile.bindings.push(binding("two", "midi:0", 8));
        let snapshot = ProfileSnapshot::new(profile);

        assert_eq!(
            snapshot.find_binding(&key("midi:0", 7), false).unwrap().id,
            "one"
        );
        assert!(snapshot.find_binding(&key("midi:9", 7), false).is_none());
        assert_eq!(
            snapshot.find_binding(&key("midi:9", 7), true).unwrap().id,
            "one"
        );
    }

    #[test]
    fn stale_device_fallback_remains_ambiguous_for_duplicate_controls() {
        let profile = Profile {
            name: "ambiguous".to_string(),
            bindings: vec![binding("one", "midi:0", 7), binding("two", "midi:1", 7)],
            osd_settings: Default::default(),
            plugin_settings: Default::default(),
            midi_device_preference: Default::default(),
            midi_device_preference_set: false,
        };
        let snapshot = ProfileSnapshot::new(profile);

        assert_eq!(
            snapshot.find_binding(&key("midi:1", 7), true).unwrap().id,
            "two"
        );
        assert!(snapshot.find_binding(&key("midi:9", 7), true).is_none());
    }
}
