use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.houmus.lotus_mobile";

pub struct LotusMobile<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> LotusMobile<R> {
    #[cfg(target_os = "android")]
    pub fn open_pdf(&self, path: &std::path::Path) -> Result<(), String> {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct OpenPdfArgs<'a> {
            path: &'a str,
        }

        #[derive(serde::Deserialize)]
        struct OpenPdfResponse {
            status: String,
        }

        let path = path
            .to_str()
            .ok_or("The PDF cache path is not valid UTF-8")?;
        let response = self
            .handle
            .run_mobile_plugin::<OpenPdfResponse>("openPdf", OpenPdfArgs { path })
            .map_err(|error| error.to_string())?;
        if response.status != "opened" {
            return Err("The Android PDF viewer did not open the file".to_string());
        }
        Ok(())
    }
}

pub trait LotusMobileExt<R: Runtime> {
    fn lotus_mobile(&self) -> &LotusMobile<R>;
}

impl<R: Runtime, T: Manager<R>> LotusMobileExt<R> for T {
    fn lotus_mobile(&self) -> &LotusMobile<R> {
        self.state::<LotusMobile<R>>().inner()
    }
}

#[must_use]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("lotus-mobile")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "LotusMobilePlugin")?;
            #[cfg(not(target_os = "android"))]
            let _ = api;
            app.manage(LotusMobile::<R> {
                #[cfg(target_os = "android")]
                handle,
                #[cfg(not(target_os = "android"))]
                marker: std::marker::PhantomData,
            });
            Ok(())
        })
        .build()
}
